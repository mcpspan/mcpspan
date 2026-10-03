package com.mcpspan.javasdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.github.javaparser.JavaParser;
import com.github.javaparser.ParseResult;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.NameExpr;
import com.github.javaparser.ast.stmt.BlockStmt;
import com.mcpspan.McpSpan;
import com.mcpspan.McpSpanOptions;
import java.io.IOException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;

/**
 * The README's samples, checked against the package: each Java sample must parse, and every method it calls on
 * McpSpan, McpSpanJavaSdk or the options builder must exist, so a rename that misses the documentation fails here
 * rather than on somebody else's machine.
 */
class ReadmeTest {

    private static String readme() throws IOException {
        return Files.readString(Path.of("..", "README.md"));
    }

    private static Set<String> methods(Class<?> type) {
        return Arrays.stream(type.getMethods()).map(Method::getName).collect(Collectors.toSet());
    }

    @Test
    void everyJavaSampleParsesAndCallsOnlyWhatExists() throws IOException {
        Matcher samples = Pattern.compile("```java\n(.*?)```", Pattern.DOTALL).matcher(readme());
        Set<String> sdk = methods(McpSpanJavaSdk.class);
        Set<String> core = methods(McpSpan.class);
        Set<String> builder = methods(McpSpanOptions.Builder.class);
        int count = 0;

        while (samples.find()) {
            count++;
            ParseResult<BlockStmt> parsed = new JavaParser().parseBlock("{" + samples.group(1) + "}");
            assertTrue(parsed.isSuccessful(), () -> "does not parse: " + samples.group(1) + parsed.getProblems());

            for (MethodCallExpr call : parsed.getResult().orElseThrow().findAll(MethodCallExpr.class)) {
                String name = call.getNameAsString();
                call.getScope().ifPresent(scope -> {
                    if (scope instanceof NameExpr target && target.getNameAsString().equals("McpSpanJavaSdk")) {
                        assertTrue(sdk.contains(name), "McpSpanJavaSdk." + name);
                    }
                    if (scope instanceof NameExpr target && target.getNameAsString().equals("McpSpan")) {
                        assertTrue(core.contains(name), "McpSpan." + name);
                    }
                    if (scope.toString().startsWith("McpSpanOptions.builder()") && !name.equals("build")) {
                        assertTrue(builder.contains(name), "McpSpanOptions.Builder." + name);
                    }
                });
            }
        }
        assertTrue(count >= 6, "found " + count + " samples");
    }

    @Test
    void theOptionsTableListsEveryOptionAndNoOther() throws IOException {
        Matcher rows = Pattern.compile("^\\| `(\\w+)` \\|", Pattern.MULTILINE).matcher(readme());
        List<String> table = rows.results().map(r -> r.group(1)).sorted().toList();
        List<String> options = Arrays.stream(McpSpanOptions.Builder.class.getDeclaredMethods())
            .filter(m -> m.getReturnType() == McpSpanOptions.Builder.class)
            .map(Method::getName).distinct().sorted().toList();

        assertEquals(options, table);
    }
}
