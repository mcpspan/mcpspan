# frozen_string_literal: true

module McpSpan
  # The listings already sent for each session, so the same answer to `tools/list` is sent once per session
  # (contract, 3.11). A client lists the tools at the start of a session and often again; the count that matters is
  # the sessions that were shown the tools, not how often they asked.
  module Listings
    # Sessions kept, the oldest forgotten first.
    MAX_SESSIONS = 10_000

    @sent = {}
    @lock = Mutex.new

    class << self
      # Whether a listing is new for its session, noting it as sent. A listing with no session always is.
      def first?(session_id, signature)
        return true if session_id.nil?

        @lock.synchronize do
          signatures = @sent.delete(session_id) || {}
          new = !signatures.key?(signature)
          signatures[signature] = true
          @sent[session_id] = signatures
          @sent.delete(@sent.keys.first) if @sent.size > MAX_SESSIONS
          new
        end
      end

      # For tests: forgets every listing sent.
      def forget
        @lock.synchronize { @sent.clear }
      end
    end
  end
end
