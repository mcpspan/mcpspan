using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using ModelContextProtocol;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace McpSpan.Internal;

/// <summary>
/// The call-tool filter every tools/call on an instrumented server passes through.
/// </summary>
/// <remarks>
/// It sits inside the MCP SDK's own error handling, so an exception a tool throws reaches it as it was thrown,
/// before the SDK turns it into an error result for the client.
/// </remarks>
internal static class ToolCallFilter
{
    public static McpRequestHandler<CallToolRequestParams, CallToolResult> Wrap(
        McpRequestHandler<CallToolRequestParams, CallToolResult> next) =>
        async (request, cancellationToken) =>
        {
            if (!Collector.Collecting)
            {
                return await next(request, cancellationToken).ConfigureAwait(false);
            }

            var tool = request.MatchedPrimitive as McpServerTool;
            var call = Begin(request, tool);
            if (call is null)
            {
                return await next(request, cancellationToken).ConfigureAwait(false);
            }

            CallToolResult result;
            try
            {
                result = await next(request, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception exception)
            {
                Failed(call, tool, exception, cancellationToken);
                throw;
            }

            Settle(call, result);
            return result;
        };

    /// <summary>What is known about a call as it starts, or null for a call not to be recorded.</summary>
    internal static Call? Begin(RequestContext<CallToolRequestParams> request, McpServerTool? tool)
    {
        try
        {
            if (tool is not null && IsExcluded(tool))
            {
                return null;
            }

            return CallFor(request, request.Params?.Name ?? string.Empty, kind: null, request.Params?.Arguments, described: null);
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>A call as it starts, with its connection and client, whatever kind of request it is.</summary>
    internal static Call CallFor<TParams>(
        RequestContext<TParams> request,
        string name,
        string? kind,
        IDictionary<string, JsonElement>? arguments,
        IReadOnlyDictionary<string, string>? described)
    {
        // Per connection: the transport it arrived on where the SDK names one, else the server's options,
        // which one process serving one stdio connection shares.
        var transport = request.JsonRpcRequest.Context?.RelatedTransport;
        var overHttp = transport is StreamableHttpServerTransport or SseResponseStreamTransport;

        return new Call
        {
            ToolName = name,
            Kind = kind,
            // Request-scoped in the SDK: the request's _meta on 2026-07-28, else this session's handshake.
            ClientName = request.Server.ClientInfo?.Name,
            ClientVersion = request.Server.ClientInfo?.Version,
            ServerVersion = request.Server.ServerOptions.ServerInfo?.Version,
            SessionId = Sessions.For((object?)transport ?? request.Server.ServerOptions, overHttp, request.Server.SessionId),
            Arguments = arguments,
            DescribedParameters = described,
        };
    }

    internal static void Settle(Call call, CallToolResult? result)
    {
        try
        {
            if (result?.IsError == true)
            {
                call.Failed(ErrorSources.Result, message: Text.ResultMessage(
                    result.Content.OfType<TextContentBlock>().Select(block => block.Text)), response: result);
                return;
            }

            call.Succeeded(result);
        }
        catch (Exception)
        {
            // Looking at a result must never change it.
        }
    }

    internal static void Failed(Call call, McpServerTool? tool, Exception exception, CancellationToken cancellationToken)
    {
        try
        {
            switch (exception)
            {
                case OperationCanceledException when cancellationToken.IsCancellationRequested:
                case InputRequiredException:
                    // Cancelled by the client, or asking it for more: neither is how the call ended.
                    return;

                case McpProtocolException { ErrorCode: McpErrorCode.InvalidParams } when tool is null:
                    // No message: the name asked for is already the event's own.
                    call.Failed(ErrorSources.UnknownTool);
                    return;

                case JsonException or ArgumentException when tool is not null && !call.Reached && !Reached(exception, tool):
                    // The SDK could not bind the arguments to the tool's parameters, and the tool never ran.
                    // No message: it can name what was sent.
                    call.Failed(ErrorSources.Arguments);
                    return;
            }

            var (type, message) = Text.Describe(exception);
            call.Failed(ErrorSources.Exception, type, message);
        }
        catch (Exception)
        {
            // Looking at a failure must never change it.
        }
    }

    /// <summary>
    /// Whether an exception passed through the tool's own code on its way here.
    /// </summary>
    /// <remarks>
    /// Its stack trace runs from where it was thrown to the filter. One thrown while the SDK bound the arguments
    /// never went through the tool's assembly; one the tool threw, or let through from something it called, did.
    /// A tool whose method cannot be found is taken to have run, so its failure is never claimed as a refusal.
    /// </remarks>
    private static bool Reached(Exception exception, McpServerTool tool) =>
        PrimitiveFilters.ReachedCode(exception, tool.Metadata);

    private static bool IsExcluded(McpServerTool tool) =>
        tool.Metadata.OfType<McpSpanExcludeAttribute>().Any();
}
