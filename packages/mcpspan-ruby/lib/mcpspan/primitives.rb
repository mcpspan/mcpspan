# frozen_string_literal: true

module McpSpan
  # Resource reads and prompt gets (contract, 3.5), on the official Ruby MCP SDK.
  #
  # The gem answers `resources/read` through `read_resource_contents`, which runs the server's read handler: its own,
  # for resources and templates defined as classes, or one the developer set with `resources_read_handler`. It
  # answers `prompts/get` through `get_prompt`, which refuses an unknown prompt and missing arguments before it calls
  # `call_prompt_template_with_args`. Hooks on those three, prepended to one server's singleton class as the tool hooks
  # are, see every read and get.
  #
  # What was asked for is named before anything runs, from the server's own records: a fixed resource by its URI, a
  # templated one by its template, never by the address the client sent, and an address with neither by its scheme
  # alone, since the rest of it came from the client.
  module Primitives
    # Set, fiber-locally, while an instrumented server gets a prompt, so it can see that the prompt was reached.
    PROMPTING = :__mcpspan_prompt

    SCHEME = /\A([a-zA-Z][a-zA-Z0-9+.-]*):/

    # A template's `{name}` variables, as the gem matches them: one or more characters other than `/`.
    VARIABLE = /\\\{([A-Za-z_]\w*)\\\}/

    # The gem's private methods these hooks take the place of. A version without them leaves resources and prompts
    # unrecorded, and tools measured as before.
    HOOKED = %i[read_resource_contents get_prompt call_prompt_template_with_args].freeze

    module_function

    def hookable?
      HOOKED.all? { |name| ::MCP::Server.private_method_defined?(name) }
    end

    # The scheme of an address, which is all of an unknown one that may be kept: `db://`.
    def scheme(uri)
      match = SCHEME.match(uri.to_s)
      match ? "#{match[1]}://" : "unknown://"
    end

    # The name a read is recorded under, and the template's variables when a template matched it.
    def resolve(uri, index, templates)
      return [uri, nil] if index.is_a?(Hash) && index.key?(uri)

      Array(templates).each do |template|
        pattern = template.uri_template
        next unless pattern.is_a?(String)

        variables = match(pattern, uri)
        return [pattern, variables] if variables
      end
      nil
    end

    def match(template, uri)
      pattern = Regexp.escape(template).gsub(VARIABLE) { "(?<#{Regexp.last_match(1)}>[^/]+)" }
      Regexp.new("\\A#{pattern}\\z").match(uri)&.named_captures
    end

    # Hooks prepended to one server's singleton class.
    module ServerHooks
      private

      def read_resource_contents(request, session: nil, **rest)
        call, known = __mcpspan_begin_read(request, session, rest[:envelope])
        return super if call.nil?

        begin
          result = super
        rescue ::MCP::CancelledError
          raise
        rescue StandardError => e
          __mcpspan_read_failed(call, known, e)
          raise
        end
        __mcpspan_succeeded(call, result)
        result
      end

      def get_prompt(request, session: nil, **rest)
        call, known = __mcpspan_begin_prompt(request, session, rest[:envelope])
        return super if call.nil?

        reached = [false]
        outer = Thread.current[PROMPTING]
        Thread.current[PROMPTING] = reached
        begin
          result = super
        rescue ::MCP::CancelledError
          raise
        rescue StandardError => e
          __mcpspan_prompt_failed(call, known, reached[0], e)
          raise
        ensure
          Thread.current[PROMPTING] = outer
        end
        __mcpspan_succeeded(call, result)
        result
      end

      def call_prompt_template_with_args(*args, **kwargs)
        reached = Thread.current[PROMPTING]
        reached[0] = true if reached
        super
      end

      def __mcpspan_begin_read(request, session, envelope)
        return nil unless Collector.collecting? && request.is_a?(Hash)

        uri = request[:uri].to_s
        name, variables = Primitives.resolve(uri, @resource_index, @resource_templates)
        known = !name.nil?
        call = Collector.begin_call(
          known ? name : Primitives.scheme(uri),
          arguments: variables,
          session_id: Instrumentation.session_id(session),
          server_version: Instrumentation.server_version(self),
          **Instrumentation.client(envelope, session, self),
          kind: "resource",
        )
        call && [call, known]
      rescue *Instrumentation::INTERNAL
        nil
      end

      def __mcpspan_begin_prompt(request, session, envelope)
        return nil unless Collector.collecting? && request.is_a?(Hash)

        name = request[:name]
        call = Collector.begin_call(
          name,
          arguments: request[:arguments],
          session_id: Instrumentation.session_id(session),
          server_version: Instrumentation.server_version(self),
          **Instrumentation.client(envelope, session, self),
          kind: "prompt",
        )
        call && [call, @prompts.key?(name)]
      rescue *Instrumentation::INTERNAL
        nil
      end

      def __mcpspan_succeeded(call, result)
        # An interim result asking the client for input settles nothing; the request that follows it does.
        Collector.record(call, success: true, response: result) unless Instrumentation.interim?(result)
      rescue *Instrumentation::INTERNAL
        nil
      end

      def __mcpspan_read_failed(call, known, error)
        if !known && Instrumentation.named?(error, "MCP::Server::ResourceNotFoundError")
          Collector.record(call, success: false, source: Source::UNKNOWN_RESOURCE)
        else
          __mcpspan_exception(call, error)
        end
      rescue *Instrumentation::INTERNAL
        nil
      end

      def __mcpspan_prompt_failed(call, known, reached, error)
        if !known
          Collector.record(call, success: false, source: Source::UNKNOWN_PROMPT)
        elsif !reached
          # Only the gem's check for missing arguments stands between finding the prompt and calling it.
          Collector.record(call, success: false, source: Source::ARGUMENTS)
        else
          __mcpspan_exception(call, error)
        end
      rescue *Instrumentation::INTERNAL
        nil
      end

      def __mcpspan_exception(call, error)
        original = error.respond_to?(:original_error) && error.original_error ? error.original_error : error
        type, message = Instrumentation.exception(original)
        Collector.record(call, success: false, source: Source::EXCEPTION, type: type, message: message)
      end
    end
  end
end
