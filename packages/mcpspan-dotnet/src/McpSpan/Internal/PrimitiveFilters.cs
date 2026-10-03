using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;
using ModelContextProtocol;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace McpSpan.Internal;

/// <summary>
/// The read-resource and get-prompt filters (contract, 3.5).
/// </summary>
/// <remarks>
/// The MCP SDK finds what a request asks for before its filters run, and hands it to them as the request's
/// matched primitive: the resource, with its URI template when it is templated, or the prompt. That names the
/// call without reading the address the client sent. A read the SDK matched to nothing is named by the scheme
/// of that address alone, since the rest of it came from the client. Like the tool filter, these sit inside
/// the SDK's error handling, so an exception reaches them as the resource or prompt threw it.
/// </remarks>
internal static partial class PrimitiveFilters
{
    public const string Resource = "resource";
    public const string Prompt = "prompt";

    public static McpRequestHandler<ReadResourceRequestParams, ReadResourceResult> WrapRead(
        McpRequestHandler<ReadResourceRequestParams, ReadResourceResult> next) =>
        async (request, cancellationToken) =>
        {
            if (!Collector.Collecting)
            {
                return await next(request, cancellationToken).ConfigureAwait(false);
            }

            var resource = request.MatchedPrimitive as McpServerResource;
            var call = BeginRead(request, resource);
            if (call is null)
            {
                return await next(request, cancellationToken).ConfigureAwait(false);
            }

            ReadResourceResult result;
            try
            {
                result = await next(request, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception exception)
            {
                Failed(call, exception, unknown: resource is null ? ErrorSources.UnknownResource : null,
                    refused: false, cancellationToken);
                throw;
            }

            call.Succeeded();
            return result;
        };

    public static McpRequestHandler<GetPromptRequestParams, GetPromptResult> WrapGet(
        McpRequestHandler<GetPromptRequestParams, GetPromptResult> next) =>
        async (request, cancellationToken) =>
        {
            if (!Collector.Collecting)
            {
                return await next(request, cancellationToken).ConfigureAwait(false);
            }

            var prompt = request.MatchedPrimitive as McpServerPrompt;
            var call = BeginGet(request);
            if (call is null)
            {
                return await next(request, cancellationToken).ConfigureAwait(false);
            }

            GetPromptResult result;
            try
            {
                result = await next(request, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception exception)
            {
                // Arguments the SDK could not bind to the prompt's parameters never reach its code.
                var refused = prompt is not null && exception is JsonException or ArgumentException
                    && !ReachedCode(exception, prompt.Metadata);
                Failed(call, exception, unknown: prompt is null ? ErrorSources.UnknownPrompt : null,
                    refused, cancellationToken);
                throw;
            }

            call.Succeeded();
            return result;
        };

    private static Call? BeginRead(RequestContext<ReadResourceRequestParams> request, McpServerResource? resource)
    {
        try
        {
            var uri = request.Params?.Uri ?? string.Empty;
            string name;
            IReadOnlyDictionary<string, string>? variables = null;

            if (resource is null)
            {
                name = SchemeOf(uri);
            }
            else if (resource.IsTemplated)
            {
                name = resource.ProtocolResourceTemplate.UriTemplate;
                variables = TemplateVariables(name);
            }
            else
            {
                name = resource.ProtocolResource?.Uri ?? uri;
            }

            return ToolCallFilter.CallFor(request, name, Resource, arguments: null, described: variables);
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static Call? BeginGet(RequestContext<GetPromptRequestParams> request)
    {
        try
        {
            var arguments = request.Params?.Arguments?.ToDictionary(entry => entry.Key, entry => entry.Value);
            return ToolCallFilter.CallFor(request, request.Params?.Name ?? string.Empty, Prompt, arguments, described: null);
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static void Failed(Call call, Exception exception, string? unknown, bool refused, CancellationToken cancellationToken)
    {
        try
        {
            if (exception is InputRequiredException
                || (exception is OperationCanceledException && cancellationToken.IsCancellationRequested))
            {
                // Asking the client for more, or cancelled by it: neither is how the call ended.
                return;
            }

            if (unknown is not null)
            {
                call.Failed(unknown);
                return;
            }

            if (refused)
            {
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

    /// <summary>The scheme of an address, which is all of an unknown one that may be kept: <c>db://</c>.</summary>
    internal static string SchemeOf(string uri)
    {
        var match = SchemePattern().Match(uri);
        return match.Success ? $"{match.Groups[1].Value}://" : "unknown://";
    }

    /// <summary>A URI template's variables, by name, each a string: their values are never read.</summary>
    internal static IReadOnlyDictionary<string, string>? TemplateVariables(string template)
    {
        var names = new Dictionary<string, string>();
        foreach (Match expression in ExpressionPattern().Matches(template))
        {
            foreach (var part in expression.Groups[1].Value.TrimStart('+', '#', '.', '/', ';', '?', '&').Split(','))
            {
                var name = part.Split(':')[0].TrimEnd('*');
                if (name.Length > 0)
                {
                    names[Text.Truncate(name, Text.MaxName)] = "string";
                }
            }
        }

        return names.Count == 0 ? null : names;
    }

    /// <summary>Whether an exception passed through the code behind a primitive on its way here.</summary>
    internal static bool ReachedCode(Exception exception, IReadOnlyList<object> metadata)
    {
        var method = metadata.OfType<MethodInfo>().FirstOrDefault();
        if (method is null)
        {
            return true;
        }

        foreach (var frame in new StackTrace(exception, fNeedFileInfo: false).GetFrames())
        {
            if (frame.GetMethod() is { } frameMethod && frameMethod.Module == method.Module)
            {
                return true;
            }
        }

        return false;
    }

    [GeneratedRegex(@"^([a-zA-Z][a-zA-Z0-9+.\-]*):")]
    private static partial Regex SchemePattern();

    [GeneratedRegex(@"\{([^}]*)\}")]
    private static partial Regex ExpressionPattern();
}
