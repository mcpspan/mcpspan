# frozen_string_literal: true

require "json"

module McpSpan
  # Which top-level arguments of a refused call did not match the tool's input schema (contract, 3.10). The server's
  # own refusal is not read: each validation library words it differently, and some quote the value the agent sent.
  # The arguments are checked here instead, against the schema the server listed, by a small set of rules that never
  # fail what they do not understand. Only names the schema declares come out, so nothing the client made up, and no
  # value, is sent.
  module ArgumentChecks
    # Names sent at most, per call.
    MAX_NAMES = 20

    class << self
      # The declared names whose arguments fail the schema, sorted, at most twenty. Both are read the way they were
      # sent, through JSON, so symbols and strings alike. Never raises.
      def invalid(schema, arguments)
        rules = plain(schema)
        return [] unless rules.is_a?(Hash)

        values = arguments.nil? ? {} : plain(arguments)
        return [] unless values.is_a?(Hash)

        names = []
        required = rules["required"]
        names.concat(required.select { |name| name.is_a?(String) && !values.key?(name) }) if required.is_a?(Array)
        properties = rules["properties"]
        if properties.is_a?(Hash)
          properties.each do |name, rule|
            names << name if values.key?(name) && !matches?(rule, values[name])
          end
        end
        names.uniq.sort.first(MAX_NAMES)
      rescue StandardError
        []
      end

      private

      def plain(value)
        JSON.parse(JSON.generate(value))
      end

      # Whether a value passes a schema under the checks the contract lists, and only those.
      def matches?(schema, value)
        return false if schema == false
        return true unless schema.is_a?(Hash)

        type = schema["type"]
        return false if type.is_a?(String) && !type?(type, value)
        return false if type.is_a?(Array) && type.all?(String) && type.none? { |name| type?(name, value) }

        allowed = schema["enum"]
        if allowed.is_a?(Array)
          sent = Definitions.canonical_text(value)
          return false if allowed.none? { |option| Definitions.canonical_text(option) == sent }
        end
        if schema.key?("const") && Definitions.canonical_text(schema["const"]) != Definitions.canonical_text(value)
          return false
        end

        within?(schema, value)
      end

      # The bounds on numbers, lengths and counts, and what objects and arrays hold.
      def within?(schema, value)
        bound = ->(name) { number?(schema[name]) ? schema[name] : nil }
        if number?(value)
          return false if bound.call("minimum")&.then { |minimum| value < minimum }
          return false if bound.call("maximum")&.then { |maximum| value > maximum }
          return false if bound.call("exclusiveMinimum")&.then { |above| value <= above }
          return false if bound.call("exclusiveMaximum")&.then { |below| value >= below }
        end

        case value
        when String
          # A Ruby string's length is in characters, which in UTF-8 are code points.
          return false if bound.call("minLength")&.then { |shortest| value.length < shortest }
          return false if bound.call("maxLength")&.then { |longest| value.length > longest }
        when Array
          return false if bound.call("minItems")&.then { |fewest| value.length < fewest }
          return false if bound.call("maxItems")&.then { |most| value.length > most }

          each = schema["items"]
          checked = each.is_a?(Hash) || [true, false].include?(each)
          return false if checked && !value.all? { |item| matches?(each, item) }
        when Hash
          required = schema["required"]
          return false if required.is_a?(Array) && required.any? { |name| name.is_a?(String) && !value.key?(name) }

          properties = schema["properties"]
          if properties.is_a?(Hash) && properties.any? { |name, rule| value.key?(name) && !matches?(rule, value[name]) }
            return false
          end
        end
        true
      end

      def type?(type, value)
        case type
        when "string" then value.is_a?(String)
        when "number" then number?(value)
        when "integer" then number?(value) && value == value.truncate
        when "boolean" then [true, false].include?(value)
        when "object" then value.is_a?(Hash)
        when "array" then value.is_a?(Array)
        when "null" then value.nil?
        # A type this list does not know is not checked.
        else true
        end
      end

      def number?(value)
        value.is_a?(Integer) || (value.is_a?(Float) && value.finite?)
      end
    end
  end
end
