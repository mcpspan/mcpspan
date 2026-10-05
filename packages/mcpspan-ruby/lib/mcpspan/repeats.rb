# frozen_string_literal: true

require "digest"

module McpSpan
  # Whether a call repeats the previous call to the same tool in the same session (contract, 3.9): an agent stuck in a
  # loop. Only the answer leaves the process. Kept here is a SHA-256 of the canonical arguments of the latest call per
  # session and tool, never sent: a digest of a short identifier or an enumerated value is found by trying every one.
  module Repeats
    # Session and tool pairs kept, the oldest forgotten first.
    MAX_KEPT = 10_000

    # Insertion-ordered: a pair noted again is moved to the end, so the first is always the longest unused.
    @latest = {}
    @lock = Mutex.new

    class << self
      # Notes a call's arguments, as the client sent them, and says whether they are the previous call's to the same
      # tool in the same session. Arguments that cannot be written down are never a repeat.
      def note(session_id, tool_name, arguments)
        digest = Digest::SHA256.digest(Definitions.canonical_text(arguments || {}))
        key = [session_id, tool_name.to_s]
        @lock.synchronize do
          previous = @latest.delete(key)
          @latest[key] = digest
          @latest.shift if @latest.size > MAX_KEPT
          previous == digest
        end
      rescue StandardError
        false
      end

      # Whether a call answers an interim result's question (2026-07-28): it then continues that call, and is neither
      # compared nor kept.
      def continues_earlier_call?(request)
        return false unless request.is_a?(Hash)

        %i[inputResponses requestState].any? do |name|
          value = request[name] || request[name.to_s]
          !value.nil? && value != ""
        end
      end

      # For tests: forgets every call.
      def forget
        @lock.synchronize { @latest.clear }
      end
    end
  end
end
