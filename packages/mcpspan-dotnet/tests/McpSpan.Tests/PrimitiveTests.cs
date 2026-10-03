using McpSpan.Internal;
using Microsoft.Extensions.DependencyInjection;
using ModelContextProtocol.Server;

namespace McpSpan.Tests;

[McpServerResourceType]
internal sealed class FlightResources
{
    [McpServerResource(UriTemplate = "config://app", Name = "config")]
    public static string Config() => "ok";

    [McpServerResource(UriTemplate = "trips://{id}", Name = "trip")]
    public static string Trip(string id) => "ok";
}

[McpServerPromptType]
internal sealed class FlightPrompts
{
    [McpServerPrompt(Name = "plan_trip")]
    public static string PlanTrip(string destination) => destination;

    [McpServerPrompt(Name = "broken")]
    public static string Broken() => throw new BookingException("no planner");
}

/// <summary>Resource reads and prompt gets (contract, 3.5), through a real client.</summary>
public sealed class PrimitiveTests
{
    [Fact]
    public async Task Records_each_read_and_get_by_what_it_is_and_never_the_address_asked_for()
    {
        await using var captured = new Captured(new McpSpanOptions { CaptureParameterNames = true });
        await using (var connection = await Connection.OpenAsync(
            b => b.WithResources<FlightResources>().WithPrompts<FlightPrompts>().WithMcpSpan(), "cursor"))
        {
            await connection.ReadAsync("config://app");
            await connection.ReadAsync("trips://secret-4412");
            await connection.ReadAsync("db://customers/4412");
            await connection.GetPromptAsync("plan_trip", new() { ["destination"] = "Lisbon" });
            await connection.GetPromptAsync("plan_trip");
            await connection.GetPromptAsync("translate");
            await connection.GetPromptAsync("broken");
        }

        var events = await captured.DeliveredAsync();

        Assert.Equal(
            [
                ("resource", "config://app", (string?)null),
                ("resource", "trips://{id}", null),
                ("resource", "db://", "unknown_resource"),
                ("prompt", "plan_trip", null),
                ("prompt", "plan_trip", "arguments"),
                ("prompt", "translate", "unknown_prompt"),
                ("prompt", "broken", "exception"),
            ],
            events.Select(e => (e.Kind!, e.ToolName, e.ErrorSource)).ToArray());
        Assert.Equal(new Dictionary<string, string> { ["id"] = "string" }, events[1].Parameters);
        Assert.Equal("BookingException", events[6].ErrorType);
        Assert.All(events, e => Assert.Equal("cursor", e.ClientType));
        Assert.DoesNotContain(events, e => $"{e.ToolName}{e.ErrorMessage}".Contains("4412", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("db://customers/4412", "db://")]
    [InlineData("file:///home/ada/cv.pdf", "file://")]
    [InlineData("customers/4412", "unknown://")]
    [InlineData("4412:secret", "unknown://")]
    public void Keeps_nothing_of_an_address_past_its_scheme(string uri, string expected) =>
        Assert.Equal(expected, PrimitiveFilters.SchemeOf(uri));

    [Fact]
    public void Names_a_templates_variables_and_nothing_else() =>
        Assert.Equal(
            new Dictionary<string, string> { ["user"] = "string", ["page"] = "string", ["q"] = "string" },
            PrimitiveFilters.TemplateVariables("users://{user}/pages/{+page}{?q}"));
}
