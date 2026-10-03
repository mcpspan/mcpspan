# frozen_string_literal: true

require "securerandom"

module McpSpan
  # Collects events and delivers them from a thread of its own.
  #
  # `record` is the only method a tool call touches, and it only appends to memory under a lock: the call returns
  # without waiting on the network.
  class Reporter
    DEFAULT_FLUSH_INTERVAL = 5.0
    DEFAULT_MAX_BATCH_SIZE = 100
    DEFAULT_MAX_QUEUE_SIZE = 10_000

    # The wait after the n-th consecutive failure: doubling to a ceiling, spread over its second half.
    def self.backoff(failures, random = rand)
      ceiling = [1.0 * (2**[failures - 1, 16].min), 60.0].min
      (ceiling / 2) + (random * ceiling / 2)
    end

    def initialize(endpoint:, send:, flush_interval:, max_batch_size:, max_queue_size:, debug:, on_diagnostic:)
      @endpoint = endpoint
      @send = send
      @flush_interval = flush_interval
      @max_batch_size = max_batch_size
      @max_queue_size = max_queue_size
      @debug = debug
      @on_diagnostic = on_diagnostic
      @lock = Mutex.new
      @wake = ConditionVariable.new
      # One delivery at a time, so the same events are never posted twice.
      @sending = Mutex.new
      @queue = []
      @dropped = 0
      @reported_drops = 0
      @failures = 0
      @next_attempt = nil
      @woken = false
      @stopped = false
      @rejected = false
      @thread = nil
      @pid = nil
    end

    # Starts delivery, announcing the server first (contract, 3.4).
    def start
      @lock.synchronize { spawn }
    end

    # Queues an event and returns at once.
    def record(event)
      @lock.synchronize do
        return if @stopped || @rejected

        # A forked child, as a web server's worker is, inherits the queue but not the thread.
        if @pid != Process.pid
          @queue.clear
          spawn
        end
        if @queue.size >= @max_queue_size
          @queue.shift
          @dropped += 1
        end
        @queue << event
        if @queue.size >= @max_batch_size
          @woken = true
          @wake.signal
        end
      end
    end

    # Delivers what is queued now, ignoring any retry delay, and carries on.
    def flush
      deliver(force: true)
    end

    # Stops delivery and makes a final attempt at what is queued, ignoring any retry delay: this is the last chance
    # these events get. A delivery already under way is waited for, rather than its events posted twice.
    def stop
      thread = @lock.synchronize do
        @stopped = true
        @woken = true
        @wake.signal
        @thread if @pid == Process.pid
      end
      thread&.join(Transport::TIMEOUT + 1)
      deliver(force: true)
    end

    private

    def spawn
      @pid = Process.pid
      @thread = Thread.new { run }
      @thread.name = "mcpspan-delivery"
      # A delivery thread must never be why a program does not exit, nor print a stray backtrace.
      @thread.report_on_exception = false
    end

    def run
      announce
      loop do
        @lock.synchronize do
          deadline = monotonic + @flush_interval
          until @woken || @stopped || @rejected
            left = deadline - monotonic
            break if left <= 0

            @wake.wait(@lock, left)
          end
          @woken = false
          return if @stopped || @rejected
        end
        deliver(force: false)
      end
    rescue StandardError => e
      log("mcpspan: delivery stopped (#{e.class}: #{e.message})")
    end

    def announce
      failure = @send.call([])
      return if failure.nil?

      if [401, 403].include?(failure.status)
        reject(failure.status)
      else
        log("mcpspan: could not announce this server to #{@endpoint} (#{failure.message}). " \
            "Events will still be delivered once it answers.")
      end
    end

    def deliver(force:)
      @lock.synchronize do
        return if @rejected
        return if !force && @next_attempt && monotonic < @next_attempt
      end
      @sending.synchronize do
        report_drops
        loop do
          batch = @lock.synchronize do
            return if @rejected

            @queue.shift(@max_batch_size)
          end
          return if batch.empty?

          failure = @send.call(batch)
          if failure
            failed(batch, failure)
            return
          end
          @lock.synchronize do
            @failures = 0
            @next_attempt = nil
          end
        end
      end
    end

    def report_drops
      dropped = @lock.synchronize do
        count = @dropped - @reported_drops
        @reported_drops = @dropped
        count
      end
      log("mcpspan: discarded #{dropped} events, the queue was full") if dropped.positive?
    end

    def failed(batch, failure)
      return reject(failure.status) if [401, 403].include?(failure.status)

      attempt = @lock.synchronize do
        if failure.retryable
          @queue.unshift(*batch)
          while @queue.size > @max_queue_size
            @queue.shift
            @dropped += 1
          end
        end
        @failures += 1
        # The longer of our own backoff and what the API asked for.
        @next_attempt = monotonic + [self.class.backoff(@failures), failure.retry_after].max
        @failures
      end
      # Refused the same way every time: dropped, and collecting goes on.
      log("mcpspan: dropped #{batch.size} events, rejected as #{failure.status}") unless failure.retryable
      log("mcpspan: delivery failed (#{failure.message}), attempt #{attempt}")
    end

    # Gives up on a key the endpoint refused, and says so once even with diagnostics off: a silent SDK collecting
    # nothing because of a mistyped key is the worst way to spend an afternoon.
    def reject(status)
      @lock.synchronize do
        return if @rejected

        @rejected = true
        @queue.clear
        @wake.signal
      end
      warn_always("mcpspan: the ingest endpoint rejected the API key (HTTP #{status}). " \
                  "Telemetry is now disabled for this process.")
    end

    def log(message)
      warn_always(message) if @debug
    end

    # The developer's callback if given, otherwise standard error. Never standard output: on the stdio transport it
    # carries the MCP protocol, and a stray line there breaks the server.
    def warn_always(message)
      if @on_diagnostic
        @on_diagnostic.call(message)
      else
        warn(message)
      end
    rescue StandardError
      nil
    end

    def monotonic
      Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end
  end
end
