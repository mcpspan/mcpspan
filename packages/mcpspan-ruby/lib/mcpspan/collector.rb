# frozen_string_literal: true

require "json"
require "securerandom"

module McpSpan
  # The one configuration a process runs with, and recording calls under it.
  module Collector
    # Said when there is a key and nowhere to send: somebody meant to collect. There is no default endpoint, since
    # mcpspan runs wherever its user runs it, and a default would send their data somewhere they did not choose.
    NO_ENDPOINT = "mcpspan: an API key is set but no endpoint, so nothing is collected. Set MCPSPAN_ENDPOINT (or the " \
                  "endpoint option) to your mcpspan installation, for example http://localhost:6271."
    # The API takes at most this many events in one request.
    MAX_EVENTS_PER_REQUEST = 1_000

    SETTINGS = %i[
      api_key endpoint capture_parameter_names server_version debug on_diagnostic flush_on_exit flush_interval
      max_batch_size max_queue_size
    ].freeze

    # What an integration knows about one call as it starts. A kind of nil is a tool call.
    Call = Struct.new(:tool_name, :parameters, :client_name, :client_version, :server_version, :session_id, :started,
                      :timestamp, :kind, :repeated, keyword_init: true,)

    @lock = Mutex.new
    @reporter = nil
    @settings = nil
    @at_exit = false
    @said_no_endpoint = false

    class << self
      # Starts collecting, or stops if there is no key to collect with. The same settings again change nothing.
      def configure(settings, sender: nil)
        resolved = resolve(settings)
        previous = @lock.synchronize do
          return if @reporter && @settings == resolved

          current = @reporter
          @reporter = nil
          @settings = nil
          current
        end
        previous&.stop

        # No key is a normal state, in development and CI, and not reported.
        return if resolved[:api_key].empty?
        return say_no_endpoint(resolved[:on_diagnostic]) if resolved[:endpoint].empty? && sender.nil?

        reporter = Reporter.new(
          endpoint: resolved[:endpoint],
          send: sender || Transport.new(resolved[:endpoint], resolved[:api_key]).method(:call),
          flush_interval: resolved[:flush_interval],
          max_batch_size: resolved[:max_batch_size],
          max_queue_size: resolved[:max_queue_size],
          debug: resolved[:debug],
          on_diagnostic: resolved[:on_diagnostic],
        )
        @lock.synchronize do
          @reporter = reporter
          @settings = resolved
        end
        at_exit_once if resolved[:flush_on_exit]
        # In the background: startup does not wait for the network.
        reporter.start
      end

      def shutdown
        reporter = @lock.synchronize do
          current = @reporter
          @reporter = nil
          @settings = nil
          current
        end
        reporter&.stop
      end

      def collecting?
        !@reporter.nil?
      end

      def flush
        @reporter&.flush
      end

      # Notes the start of a call, or nil when nothing is being recorded. The clock is read first. A server version
      # the SDK was told wins over the one the server gives itself.
      def begin_call(tool_name, arguments:, session_id:, kind: nil, client_name: nil, client_version: nil,
                     server_version: nil)
        started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        timestamp = Time.now.utc
        settings = @settings
        return nil if settings.nil?

        Call.new(
          tool_name: tool_name.to_s,
          parameters: settings[:capture_parameter_names] ? Text.describe_parameters(arguments) : nil,
          client_name: client_name,
          client_version: client_version,
          server_version: settings[:server_version].empty? ? server_version : settings[:server_version],
          session_id: session_id,
          started: started,
          timestamp: timestamp,
          kind: kind,
        )
      end

      # The largest size an event carries; anything larger is sent as this (contract, 3.7).
      MAX_RESPONSE_BYTES = 2_147_483_647

      # Size of an answer in bytes of its compact JSON (contract, 3.7), or nil when there is none or it cannot be
      # encoded. The JSON is counted and dropped; nothing of it is kept or sent.
      def response_bytes(response)
        return nil if response.nil?

        value = response.is_a?(Hash) || response.is_a?(Array) || response.is_a?(String) ? response : response.to_h
        [JSON.generate(value).bytesize, MAX_RESPONSE_BYTES].min
      rescue StandardError
        nil
      end

      # Builds the event for a finished call and queues it. It never blocks on the network. `response` is the answer,
      # when there was one, to be measured.
      def record(call, success:, source: nil, type: nil, message: nil, response: nil)
        duration_ms = (Process.clock_gettime(Process::CLOCK_MONOTONIC) - call.started) * 1000.0
        reporter = @reporter
        return if reporter.nil?

        reporter.record(Event.new(
          id: SecureRandom.uuid,
          kind: call.kind,
          tool_name: Text.truncate(call.tool_name, Text::MAX_NAME),
          duration_ms: duration_ms,
          success: success,
          error_source: source,
          error_type: type && Text.truncate(type, Text::MAX_NAME),
          error_message: message.nil? || message.empty? ? nil : message,
          client_type: Text.client_type(call.client_name),
          client_name: Text.client_name(call.client_name),
          client_version: Text.version(call.client_version),
          server_version: Text.version(call.server_version),
          response_bytes: response_bytes(response),
          # A tool the server has, refused arguments included: often the schema is why.
          definition_hash: call.kind.nil? && source != Source::UNKNOWN_TOOL ? Definitions.of(call.tool_name) : nil,
          repeated: call.kind.nil? && call.repeated ? true : nil,
          timestamp: call.timestamp.strftime("%Y-%m-%dT%H:%M:%S.%LZ"),
          session_id: call.session_id,
          parameters: call.parameters,
        ))
      rescue StandardError
        nil
      end

      # For tests: forgets that the missing endpoint was already mentioned.
      def forget_no_endpoint_notice
        @lock.synchronize { @said_no_endpoint = false }
      end

      private

      # Said unasked, as a refused key is: without it the data goes nowhere and nothing tells anyone.
      def say_no_endpoint(on_diagnostic)
        first = @lock.synchronize do
          said = @said_no_endpoint
          @said_no_endpoint = true
          !said
        end
        return unless first

        on_diagnostic ? on_diagnostic.call(NO_ENDPOINT) : warn(NO_ENDPOINT)
      rescue StandardError
        nil
      end

      def at_exit_once
        @lock.synchronize do
          return if @at_exit

          @at_exit = true
        end
        # Runs when the program ends on its own, not on a signal it does not handle; that stays the program's own.
        at_exit do
          reporter = @reporter
          reporter.stop if reporter && @settings&.fetch(:flush_on_exit)
        rescue StandardError
          nil
        end
      end

      def resolve(settings)
        debug = settings[:debug] ? true : !settings[:on_diagnostic].nil?
        warn = lambda do |message|
          next unless debug

          settings[:on_diagnostic] ? settings[:on_diagnostic].call(message) : warn(message)
        end
        unknown = settings.keys - SETTINGS
        warn.call("mcpspan: ignoring unknown settings #{unknown.join(", ")}") unless unknown.empty?

        # A malformed setting falls back to its default, and says so when asked.
        positive = lambda do |name, default, kind|
          value = settings[name]
          next default if value.nil?
          next value if value.is_a?(kind) && value.positive?

          warn.call("mcpspan: ignoring #{name}=#{value.inspect}, expected a positive number")
          default
        end
        on_diagnostic = settings[:on_diagnostic]
        on_diagnostic = nil unless on_diagnostic.respond_to?(:call)

        {
          api_key: first_set(settings[:api_key], ENV.fetch("MCPSPAN_API_KEY", nil)),
          endpoint: first_set(settings[:endpoint], ENV.fetch("MCPSPAN_ENDPOINT", nil)),
          capture_parameter_names: settings[:capture_parameter_names] ? true : false,
          server_version: first_set(settings[:server_version], ENV.fetch("MCPSPAN_SERVER_VERSION", nil)),
          debug: debug,
          on_diagnostic: on_diagnostic,
          flush_on_exit: settings.fetch(:flush_on_exit, true) ? true : false,
          flush_interval: positive.call(:flush_interval, Reporter::DEFAULT_FLUSH_INTERVAL, Numeric).to_f,
          max_batch_size: [positive.call(:max_batch_size, Reporter::DEFAULT_MAX_BATCH_SIZE, Integer),
                           MAX_EVENTS_PER_REQUEST,].min,
          max_queue_size: positive.call(:max_queue_size, Reporter::DEFAULT_MAX_QUEUE_SIZE, Integer),
        }
      end

      def first_set(*values)
        values.map { |value| value.to_s.strip }.find { |value| !value.empty? } || ""
      end
    end
  end
end
