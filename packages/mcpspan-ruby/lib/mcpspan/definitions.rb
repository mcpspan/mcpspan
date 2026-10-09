# frozen_string_literal: true

require "digest"
require "json"

module McpSpan
  # Tool definitions as the server lists them, fingerprinted (contract, 3.8). Rewording a description can change how
  # agents use a tool more than a change to its code; the fingerprint is taken from the answer to `tools/list`, what
  # an agent actually read, and sent with every call to the tool. Kept for the process: one process reports to one
  # server.
  module Definitions
    HASHED = %w[name title description inputSchema].freeze
    ESCAPES = { '"' => '\\"', "\\" => "\\\\", "\b" => "\\b", "\f" => "\\f", "\n" => "\\n", "\r" => "\\r",
                "\t" => "\\t", }.freeze

    @listed = {}
    # Each tool's input schema as last listed, to tell which arguments a refusal was over (contract, 3.10).
    @schemas = {}
    @lock = Mutex.new

    class << self
      # The latest fingerprint listed for a tool, or nil when no listing in this process named it.
      def of(tool_name)
        @lock.synchronize { @listed[tool_name] }
      end

      # The latest input schema listed for a tool, or nil when no listing in this process named it.
      def schema_of(tool_name)
        @lock.synchronize { @schemas[tool_name] }
      end

      # Notes every tool in a listing, in whatever key style the gem keeps them. Never raises.
      def note(tools)
        JSON.parse(JSON.generate(Array(tools))).each do |tool|
          next unless tool.is_a?(Hash) && tool["name"].is_a?(String)

          fingerprint = hash(tool)
          @lock.synchronize do
            @listed[tool["name"]] = fingerprint if fingerprint
            @schemas[tool["name"]] = tool["inputSchema"]
          end
        end
      rescue StandardError
        nil
      end

      # For tests: forgets every listing.
      def forget
        @lock.synchronize do
          @listed.clear
          @schemas.clear
        end
      end

      # The first 16 hex characters of the SHA-256 of the tool's name, title, description and input schema, as
      # canonical JSON; nil for a definition that cannot be written so.
      def hash(tool)
        hashed = HASHED.each_with_object({}) { |field, out| out[field] = tool[field] unless tool[field].nil? }
        Digest::SHA256.hexdigest(canonical(hashed))[0, 16]
      rescue StandardError
        nil
      end

      # A value as canonical JSON (contract, 3.8), read the way it was sent: through JSON, so symbols and strings
      # alike. Raises on what cannot be written so.
      def canonical_text(value)
        canonical(JSON.parse(JSON.generate(value)))
      end

      private

      # Sorted keys, no whitespace, minimal escaping: the same text in every SDK.
      def canonical(value)
        case value
        when nil then "null"
        when true then "true"
        when false then "false"
        when Integer then value.to_s
        when Float
          raise ArgumentError, "not a JSON number" unless value.finite?

          value == value.floor && value.abs < 1e15 ? value.to_i.to_s : value.to_s
        when String then text(value)
        when Array then "[#{value.map { |item| canonical(item) }.join(",")}]"
        when Hash
          pairs = value.map { |key, item| [key.to_s, item] }.sort_by(&:first)
          "{#{pairs.map { |key, item| "#{text(key)}:#{canonical(item)}" }.join(",")}}"
        else raise ArgumentError, "cannot fingerprint #{value.class}"
        end
      end

      def text(value)
        out = +'"'
        value.each_char do |character|
          out << (ESCAPES[character] || (character.ord < 0x20 ? format("\\u%04x", character.ord) : character))
        end
        out << '"'
      end
    end
  end
end
