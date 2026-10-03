using System.Reflection;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace McpSpan.Tests;

/// <summary>
/// The README's samples, checked against the package: each must parse, and every member of McpSpanSdk and
/// McpSpanOptions it names must exist, so a rename that misses the documentation fails here rather than on
/// somebody else's machine.
/// </summary>
public sealed partial class ReadmeTests
{
    [GeneratedRegex("```csharp\n(.*?)```", RegexOptions.Singleline)]
    private static partial Regex Samples();

    [GeneratedRegex(@"^\| `(\w+)` \|", RegexOptions.Multiline)]
    private static partial Regex OptionRows();

    private static string Readme()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "README.md")))
        {
            directory = directory.Parent;
        }

        return File.ReadAllText(Path.Combine(directory!.FullName, "README.md"));
    }

    [Fact]
    public void Every_sample_parses_and_names_only_what_exists()
    {
        var samples = Samples().Matches(Readme()).Select(m => m.Groups[1].Value).ToList();
        Assert.True(samples.Count >= 6, $"found {samples.Count} samples");

        var sdk = typeof(McpSpanSdk).GetMembers(BindingFlags.Public | BindingFlags.Static).Select(m => m.Name).ToHashSet();
        var options = typeof(McpSpanOptions).GetProperties().Select(p => p.Name).ToHashSet();

        foreach (var sample in samples)
        {
            var cancellationToken = TestContext.Current.CancellationToken;
            var tree = CSharpSyntaxTree.ParseText(
                sample, new CSharpParseOptions(kind: SourceCodeKind.Script), cancellationToken: cancellationToken);
            Assert.DoesNotContain(tree.GetDiagnostics(cancellationToken), d => d.Severity == DiagnosticSeverity.Error);

            foreach (var access in tree.GetRoot(cancellationToken).DescendantNodes().OfType<MemberAccessExpressionSyntax>())
            {
                if (access.Expression is IdentifierNameSyntax { Identifier.Text: "McpSpanSdk" })
                {
                    Assert.Contains(access.Name.Identifier.Text, sdk);
                }
            }

            foreach (var creation in tree.GetRoot(cancellationToken).DescendantNodes().OfType<BaseObjectCreationExpressionSyntax>())
            {
                if (creation is ObjectCreationExpressionSyntax { Type: IdentifierNameSyntax { Identifier.Text: "McpSpanOptions" } }
                    && creation.Initializer is { } initializer)
                {
                    foreach (var assignment in initializer.Expressions.OfType<AssignmentExpressionSyntax>())
                    {
                        Assert.Contains(((IdentifierNameSyntax)assignment.Left).Identifier.Text, options);
                    }
                }
            }
        }
    }

    [Fact]
    public void The_options_table_lists_every_option_and_no_other()
    {
        var rows = OptionRows().Matches(Readme()).Select(m => m.Groups[1].Value).ToHashSet();

        Assert.Equal(typeof(McpSpanOptions).GetProperties().Select(p => p.Name).Where(n => n != "EqualityContract").ToHashSet(), rows);
    }
}
