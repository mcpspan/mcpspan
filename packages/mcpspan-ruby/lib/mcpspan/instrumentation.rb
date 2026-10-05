# frozen_string_literal: true

require "securerandom"

module McpSpan
  # Measuring the tools of a server built on the official Ruby MCP SDK, the `mcp` gem.
  #
  # The gem has one `around_request` slot, which belongs to the developer, and it sees neither a call's arguments
  # nor its result. So an instrumented server gets this module prepended to its own singleton class: `call_tool`
  # sees the whole call, and `call_tool_with_args`, which the gem calls only once the arguments have passed its
  # checks, shows directly whether the call reached the tool. Other servers, and the gem's classes, are untouched.
  module Instrumentation
    # Set, fiber-locally, while an instrumented server handles a call, so a tracked tool inside it counts nothing
    # twice and the server can see that the tool was reached.
    CURRENT = :__mcpspan_call

    # What an instrumented server knows about the call it is handling.
    State = Struct.new(:reached)

    # Named, not referenced: the gem autoloads these, and loading the HTTP transport needs the rack gem, which a stdio
    # server need not have. Touching the constant there would raise LoadError inside a tool call.
    HTTP_TRANSPORT = "MCP::Server::Transports::StreamableHTTPTransport"
    INPUT_REQUIRED = "MCP::InputRequiredResult"

    # What a hook rescues so that measuring can never be why a call fails: StandardError, and ScriptError for a
    # library that could not be loaded. Signals and exits pass through.
    INTERNAL = [StandardError, ScriptError].freeze

    module_function

    # The gem's private methods the hooks take the place of. If a version renames them, instrumenting leaves the
    # server as it was rather than guessing; test/instrument_test.rb fails first.
    HOOKED = %i[call_tool call_tool_with_args].freeze

    def instrument(server)
      return server unless defined?(::MCP::Server) && server.is_a?(::MCP::Server)
      return server if server.singleton_class.include?(ServerHooks)
      return server unless hookable?

      server.singleton_class.prepend(ServerHooks)
      server.singleton_class.prepend(Primitives::ServerHooks) if Primitives.hookable?
      watch_listings(server)
      server
    end

    # Notes the tools each `tools/list` answer describes (contract, 3.8). The gem binds its handlers when the server
    # is built, so the bound handler is wrapped where the server keeps it, taking the server's context only if the
    # handler it wraps asks for it, as the gem decides from the handler's own parameters.
    def watch_listings(server)
      handlers = server.instance_variable_get(:@handlers)
      method = ::MCP::Methods::TOOLS_LIST
      original = handlers.is_a?(Hash) ? handlers[method] : nil
      return unless original.respond_to?(:call) && original.respond_to?(:parameters)

      note = lambda do |result|
        Definitions.note(result[:tools] || result["tools"]) if Collector.collecting? && result.is_a?(Hash)
        result
      end
      contextual = original.parameters.any? { |kind, name| %i[key keyreq].include?(kind) && name == :server_context }
      handlers[method] = if contextual
                           lambda do |params, server_context: nil|
                             note.call(original.call(params, server_context: server_context))
                           end
                         else
                           ->(params) { note.call(original.call(params)) }
                         end
    rescue StandardError
      nil
    end

    def hookable?
      HOOKED.all? { |name| ::MCP::Server.private_method_defined?(name) }
    end

    def excluded?(tool, name)
      McpSpan.excluded_names.include?(name.to_s) || tool&.instance_variable_get(:@__mcpspan_excluded)
    end

    # Our identifier for the connection a call arrived on, or nil for none.
    #
    # Over HTTP without a transport session (stateless, and every call on 2026-07-28, which has no sessions and for
    # which the gem makes a throwaway session per request) there is none: each call would otherwise be a session of
    # its own. The identifier is random, kept on the gem's session object, and never derived from the transport's.
    def session_id(session)
      return nil if session.nil?

      transport = session.instance_variable_get(:@transport)
      over_http = named?(transport, HTTP_TRANSPORT)
      return nil if over_http && (session.session_id.nil? || session.era == :modern)

      session.instance_variable_get(:@__mcpspan_session) ||
        session.instance_variable_set(:@__mcpspan_session, SecureRandom.uuid)
    end

    # The client's name and version: from the call itself on 2026-07-28, else from its connection's handshake.
    def client(envelope, session, server)
      info = envelope&.client_info || session&.client || server.instance_variable_get(:@client)
      return {} unless info.is_a?(Hash)

      name = info[:name] || info["name"]
      version = info[:version] || info["version"]
      { client_name: name&.to_s, client_version: version&.to_s }
    end

    # The version the server gives itself, `MCP::Server.new(version:)`. Unset, the gem announces its default.
    def server_version(server)
      server.respond_to?(:version) ? server.version&.to_s : nil
    end

    def result_text(result)
      content = result[:content] || result["content"] || []
      texts = content.filter_map do |block|
        next unless block.is_a?(Hash)

        type = block[:type] || block["type"]
        (block[:text] || block["text"]).to_s if type.to_s == "text"
      end
      Text.truncate(texts.join(" ").strip, Text::MAX_RESULT_MESSAGE)
    end

    # Whether an object is of a class, or a subclass, known here only by name.
    def named?(object, class_name)
      object.class.ancestors.any? { |ancestor| ancestor.name == class_name }
    end

    def interim?(result)
      named?(result, INPUT_REQUIRED)
    end

    def exception(error)
      [error.class.name || "Exception", Text.truncate(error.message.to_s, Text::MAX_EXCEPTION_MESSAGE)]
    end

    # Hooks prepended to one server's singleton class.
    module ServerHooks
      private

      def call_tool(request, session: nil, **rest)
        call, tool = __mcpspan_begin(request, session, rest[:envelope])
        return super if call.nil?

        state = State.new(false)
        outer = Thread.current[CURRENT]
        Thread.current[CURRENT] = state
        begin
          result = super
        rescue ::MCP::CancelledError
          # A cancelled call has no outcome to record.
          raise
        rescue StandardError => e
          __mcpspan_failed(call, tool, state, e)
          raise
        ensure
          Thread.current[CURRENT] = outer
        end
        __mcpspan_settled(call, state, result)
        result
      end

      def call_tool_with_args(*args, **kwargs)
        state = Thread.current[CURRENT]
        state.reached = true if state
        super
      end

      def __mcpspan_begin(request, session, envelope)
        return nil unless Collector.collecting? && request.is_a?(Hash)

        name = request[:name]
        tool = tools[name]
        return nil if Instrumentation.excluded?(tool, name)

        call = Collector.begin_call(
          name,
          arguments: request[:arguments],
          session_id: Instrumentation.session_id(session),
          server_version: Instrumentation.server_version(self),
          **Instrumentation.client(envelope, session, self),
        )
        # Compared once, as the request arrives, before any validation (contract, 3.9).
        if call&.session_id && !Repeats.continues_earlier_call?(request)
          call.repeated = Repeats.note(call.session_id, name, request[:arguments])
        end
        [call, tool]
      rescue *INTERNAL
        nil
      end

      def __mcpspan_failed(call, tool, state, error)
        if tool.nil?
          Collector.record(call, success: false, source: Source::UNKNOWN_TOOL)
        else
          # The gem wraps what a tool raised, and keeps it; the tool's own class is what is worth recording.
          original = error.respond_to?(:original_error) && error.original_error ? error.original_error : error
          type, message = Instrumentation.exception(state.reached ? original : error)
          Collector.record(call, success: false, source: Source::EXCEPTION, type: type, message: message)
        end
      rescue *INTERNAL
        nil
      end

      def __mcpspan_settled(call, state, result)
        # An interim result asking the client for input settles nothing; the call that follows it does.
        return if Instrumentation.interim?(result)
        return Collector.record(call, success: true, response: result) unless result.is_a?(Hash) && result[:isError]

        # The gem refuses missing or invalid arguments with an error result, before the tool is called.
        if state.reached
          Collector.record(call, success: false, source: Source::RESULT, message: Instrumentation.result_text(result),
                                 response: result,)
        else
          Collector.record(call, success: false, source: Source::ARGUMENTS)
        end
      rescue *INTERNAL
        nil
      end
    end

    # Hooks prepended to one tracked tool class's singleton class.
    module ToolHooks
      def call(*args, **kwargs, &)
        # Inside an instrumented server, the server measures the call.
        return super if Thread.current[CURRENT] || !Collector.collecting? || Instrumentation.excluded?(self, name_value)

        # Recorded by hand, the call cannot see its connection or its client.
        call = Collector.begin_call(name_value, arguments: kwargs.except(:server_context),
                                                client_name: nil, session_id: nil,)
        begin
          result = super
        rescue StandardError => e
          type, message = Instrumentation.exception(e)
          Collector.record(call, success: false, source: Source::EXCEPTION, type: type, message: message) if call
          raise
        end
        if call
          hash = result.respond_to?(:to_h) ? result.to_h : {}
          if hash[:isError]
            Collector.record(call, success: false, source: Source::RESULT, message: Instrumentation.result_text(hash),
                                   response: hash,)
          elsif !Instrumentation.interim?(result)
            Collector.record(call, success: true, response: hash)
          end
        end
        result
      end
    end
  end
end
