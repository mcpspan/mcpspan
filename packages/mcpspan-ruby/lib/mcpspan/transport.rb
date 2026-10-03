# frozen_string_literal: true

require "net/http"
require "time"
require "uri"

module McpSpan
  # A delivery that did not succeed, and whether sending the same batch again could work.
  Failure = Struct.new(:message, :status, :retryable, :retry_after, keyword_init: true)

  # Posts batches to the ingest API. It neither retries nor swallows: it answers nil for a delivery, or a Failure.
  class Transport
    TIMEOUT = 10
    # The longest Retry-After followed: a server asking for longer is wrong or unwell.
    MAX_RETRY_AFTER = 300

    def initialize(endpoint, api_key)
      @uri = URI.join("#{endpoint.chomp("/")}/", "v1/events")
      @headers = {
        "Content-Type" => "application/json",
        "Authorization" => "Bearer #{api_key}",
        "User-Agent" => "mcpspan/#{VERSION} (ruby)",
      }
    end

    def call(events)
      http = Net::HTTP.new(@uri.host, @uri.port)
      http.use_ssl = @uri.scheme == "https"
      http.open_timeout = http.read_timeout = http.write_timeout = TIMEOUT
      # Net::HTTP never follows a redirect, which is what we want: a redirected POST delivers nothing.
      response = http.post(@uri.request_uri, Event.batch(events), @headers)
      status = response.code.to_i
      return nil if (200..299).cover?(status)

      Failure.new(
        message: "ingest API answered #{status}",
        status: status,
        retryable: status == 408 || status == 429 || status >= 500,
        retry_after: self.class.retry_after(response["retry-after"]),
      )
    rescue StandardError => e
      # Unreachable, reset, timed out: the moment, not the batch.
      Failure.new(message: "failed to reach #{@uri} (#{e.class}: #{e.message})", status: nil, retryable: true,
                  retry_after: 0,)
    end

    # Retry-After in either form, whole seconds or an HTTP date. Zero leaves the SDK's own backoff to decide.
    def self.retry_after(value, now: Time.now)
      return 0 if value.nil?

      value = value.strip
      wait = if value.match?(/\A\d+\z/)
               value.to_i
             else
               begin
                 Time.httpdate(value) - now
               rescue ArgumentError
                 0
               end
             end
      wait.clamp(0, MAX_RETRY_AFTER)
    end
  end
end
