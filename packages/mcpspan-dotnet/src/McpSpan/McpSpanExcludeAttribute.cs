namespace McpSpan;

/// <summary>
/// Leaves a tool out of the numbers entirely, refused calls to it included.
/// </summary>
/// <remarks>
/// For tools called by machinery rather than agents: a health check polled every few seconds would outnumber
/// everything a person did, and drag the whole server's error rate and response time towards its own. Placed on
/// the tool's own method, so a rename carries it along.
/// </remarks>
[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class, Inherited = false)]
public sealed class McpSpanExcludeAttribute : Attribute;
