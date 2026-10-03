# frozen_string_literal: true

module McpSpan
  # Limits the ingest API enforces, and the text that has to fit them. A batch holding one field over its limit is
  # refused whole, so everything that comes from outside the developer's control is cut before it is sent.
  module Text
    MAX_NAME = 200
    MAX_EXCEPTION_MESSAGE = 500
    MAX_RESULT_MESSAGE = 200
    MAX_DESCRIBED_PARAMETERS = 50
    # A release, a tag, a commit: the server's or the client's.
    MAX_VERSION = 100

    # First match wins, so `claude-code` is tested before `claude`.
    CLIENT_TYPES = [
      [["claude-code", "claude code"], "claude-code"],
      [["claude"], "claude"],
      [["cursor"], "cursor"],
      [%w[chatgpt openai], "chatgpt"],
      [["inspector"], "mcp-inspector"],
    ].freeze

    module_function

    # Cuts text to a limit in characters, leaving a visible sign that something was removed.
    def truncate(text, limit)
      text = text.to_s
      text.length <= limit ? text : "#{text[0, limit - 3]}..."
    end

    def client_type(name)
      return "unknown" if name.nil? || name.strip.empty?

      lower = name.downcase
      CLIENT_TYPES.each do |needles, type|
        return type if needles.any? { |needle| lower.include?(needle) }
      end
      "other"
    end

    def client_name(name)
      return nil if name.nil? || name.strip.empty?

      truncate(name, MAX_NAME)
    end

    def version(version)
      version = version.to_s.strip
      version.empty? ? nil : truncate(version, MAX_VERSION)
    end

    # Parameter names and their JSON types. Values are never read beyond their type.
    def describe_parameters(arguments)
      return nil unless arguments.is_a?(Hash) && !arguments.empty?

      arguments.first(MAX_DESCRIBED_PARAMETERS).to_h do |name, value|
        [truncate(name, MAX_NAME), json_type(value)]
      end
    end

    def json_type(value)
      case value
      when nil then "null"
      when true, false then "boolean"
      when Numeric then "number"
      when String, Symbol then "string"
      when Array then "array"
      else "object"
      end
    end
  end
end
