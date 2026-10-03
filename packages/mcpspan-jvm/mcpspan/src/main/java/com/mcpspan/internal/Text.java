package com.mcpspan.internal;

import java.util.List;

/** Limits the ingest API enforces, and cutting text to them. Internal: not part of the package's API. */
public final class Text {

    /** A tool, an error type, a client, a parameter name. The API refuses a whole batch over it. */
    public static final int MAX_NAME = 200;

    /** Written by developers for developers: mostly safe to keep, and worth reading in full. */
    public static final int MAX_EXCEPTION_MESSAGE = 500;

    /** Written for a model to read, so more likely to quote what the user asked. */
    public static final int MAX_RESULT_MESSAGE = 200;

    private Text() {
    }

    /** A version, the server's or the client's. */
    public static final int MAX_VERSION = 100;

    /** A version as it is sent: trimmed, cut to its limit, or null when there is none. */
    public static String version(String version) {
        if (version == null || version.isBlank()) {
            return null;
        }
        return truncate(version.trim(), MAX_VERSION);
    }

    /** Cuts text to a limit in code points, never splitting one, with a visible sign of the cut. */
    public static String truncate(String text, int limit) {
        if (text.codePointCount(0, text.length()) <= limit) {
            return text;
        }
        return text.substring(0, text.offsetByCodePoints(0, limit - 3)) + "...";
    }

    /** The kind of an exception, as its class names it, cut to the limit. */
    public static String errorType(Throwable error) {
        return truncate(error.getClass().getSimpleName().isEmpty() ? error.getClass().getName()
            : error.getClass().getSimpleName(), MAX_NAME);
    }

    /** The message of an exception, cut, or null when it has none. Survives a message that throws. */
    public static String errorMessage(Throwable error) {
        String message;
        try {
            message = error.getMessage();
        }
        catch (RuntimeException ignored) {
            message = null;
        }
        return message == null || message.isEmpty() ? null : truncate(message, MAX_EXCEPTION_MESSAGE);
    }

    /** The text blocks of a result that reported an error, joined and cut. Nothing else is read. */
    public static String resultMessage(List<String> texts) {
        String joined = String.join(" ", texts).trim();
        return joined.isEmpty() ? null : truncate(joined, MAX_RESULT_MESSAGE);
    }
}
