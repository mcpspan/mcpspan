package com.mcpspan.internal;

import java.util.List;
import java.util.Map;
import java.util.TreeSet;

/**
 * Which top-level arguments of a refused call did not match the tool's input schema (contract, 3.10). The server's
 * own refusal is not read: each validation library words it differently, and some quote the value the agent sent.
 * The arguments are checked here instead, against the schema the server listed, by a small set of rules that never
 * fail what they do not understand. Only names the schema declares come out, so nothing the client made up, and no
 * value, is sent. Schemas and arguments are plain maps, lists and values. Internal: not part of the package's API.
 */
public final class ArgumentChecks {

    /** Names sent at most, per call. */
    private static final int MAX_NAMES = 20;

    private ArgumentChecks() {
    }

    /** The declared names whose arguments fail the schema, sorted, at most twenty. Never throws. */
    public static List<String> invalid(Object schema, Object arguments) {
        try {
            if (!(schema instanceof Map<?, ?> rules)) {
                return List.of();
            }
            Object values = arguments == null ? Map.of() : arguments;
            if (!(values instanceof Map<?, ?> given)) {
                return List.of();
            }

            TreeSet<String> names = new TreeSet<>();
            if (rules.get("required") instanceof List<?> required) {
                for (Object name : required) {
                    if (name instanceof String text && !given.containsKey(text)) {
                        names.add(text);
                    }
                }
            }
            if (rules.get("properties") instanceof Map<?, ?> properties) {
                for (Map.Entry<?, ?> entry : properties.entrySet()) {
                    if (entry.getKey() instanceof String name && given.containsKey(name)
                        && !matches(entry.getValue(), given.get(name))) {
                        names.add(name);
                    }
                }
            }
            return names.stream().limit(MAX_NAMES).toList();
        }
        catch (RuntimeException e) {
            return List.of();
        }
    }

    /** Whether a value passes a schema under the checks the contract lists, and only those. */
    private static boolean matches(Object schema, Object value) {
        if (Boolean.FALSE.equals(schema)) {
            return false;
        }
        if (!(schema instanceof Map<?, ?> rules)) {
            return true;
        }

        Object type = rules.get("type");
        if (type instanceof String name && !isType(name, value)) {
            return false;
        }
        if (type instanceof List<?> names && names.stream().allMatch(String.class::isInstance)
            && names.stream().noneMatch(name -> isType((String) name, value))) {
            return false;
        }

        if (rules.get("enum") instanceof List<?> allowed) {
            String sent = Definitions.canonicalText(value);
            if (allowed.stream().noneMatch(option -> Definitions.canonicalText(option).equals(sent))) {
                return false;
            }
        }
        if (rules.containsKey("const")
            && !Definitions.canonicalText(rules.get("const")).equals(Definitions.canonicalText(value))) {
            return false;
        }

        Double number = numberOf(value);
        if (number != null) {
            Double bound;
            if ((bound = numberOf(rules.get("minimum"))) != null && number < bound) {
                return false;
            }
            if ((bound = numberOf(rules.get("maximum"))) != null && number > bound) {
                return false;
            }
            if ((bound = numberOf(rules.get("exclusiveMinimum"))) != null && number <= bound) {
                return false;
            }
            if ((bound = numberOf(rules.get("exclusiveMaximum"))) != null && number >= bound) {
                return false;
            }
        }

        if (value instanceof String text) {
            // Code points, not UTF-16 units: a character outside the BMP is one.
            int length = text.codePointCount(0, text.length());
            Double bound;
            if ((bound = numberOf(rules.get("minLength"))) != null && length < bound) {
                return false;
            }
            if ((bound = numberOf(rules.get("maxLength"))) != null && length > bound) {
                return false;
            }
        }

        if (value instanceof List<?> items) {
            Double bound;
            if ((bound = numberOf(rules.get("minItems"))) != null && items.size() < bound) {
                return false;
            }
            if ((bound = numberOf(rules.get("maxItems"))) != null && items.size() > bound) {
                return false;
            }
            Object each = rules.get("items");
            if ((each instanceof Map<?, ?> || each instanceof Boolean)
                && !items.stream().allMatch(item -> matches(each, item))) {
                return false;
            }
        }

        if (value instanceof Map<?, ?> object) {
            if (rules.get("required") instanceof List<?> required
                && required.stream().anyMatch(name -> name instanceof String key && !object.containsKey(key))) {
                return false;
            }
            if (rules.get("properties") instanceof Map<?, ?> properties) {
                for (Map.Entry<?, ?> entry : properties.entrySet()) {
                    if (object.containsKey(entry.getKey()) && !matches(entry.getValue(), object.get(entry.getKey()))) {
                        return false;
                    }
                }
            }
        }

        return true;
    }

    private static boolean isType(String type, Object value) {
        return switch (type) {
            case "string" -> value instanceof String;
            case "number" -> numberOf(value) != null;
            case "integer" -> {
                Double number = numberOf(value);
                yield number != null && number == Math.rint(number);
            }
            case "boolean" -> value instanceof Boolean;
            case "object" -> value instanceof Map<?, ?>;
            case "array" -> value instanceof List<?>;
            case "null" -> value == null;
            // A type this list does not know is not checked.
            default -> true;
        };
    }

    private static Double numberOf(Object value) {
        if (!(value instanceof Number number)) {
            return null;
        }
        double d = number.doubleValue();
        return Double.isFinite(d) ? d : null;
    }
}
