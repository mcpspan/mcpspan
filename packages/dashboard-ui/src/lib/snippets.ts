/**
 * The line that connects a server, in every language an SDK exists for, and
 * for each MCP SDK where a language has more than one.
 *
 * Built on the server, where the address of this installation is known, and
 * handed to the switcher that shows one at a time.
 */

interface SnippetVariant {
  id: string;
  /** Named only when a language has more than one. */
  label: string;
  code: string;
  /** A sentence under the code, where the line alone would mislead. */
  note?: string;
}

export interface SnippetLanguage {
  id: string;
  label: string;
  variants: SnippetVariant[];
}

export function snippets(endpoint: string): SnippetLanguage[] {
  const javaBuilder = `McpSpanOptions.builder()
    .apiKey(System.getenv("MCPSPAN_API_KEY"))
    .endpoint("${endpoint}")
    .build()`;

  return [
    {
      id: 'typescript',
      label: 'TypeScript',
      variants: [
        {
          id: 'default',
          label: '',
          code: `import { instrument } from 'mcpspan';

instrument(server, {
  apiKey: process.env.MCPSPAN_API_KEY,
  endpoint: '${endpoint}',
});`,
        },
      ],
    },
    {
      id: 'python',
      label: 'Python',
      variants: [
        {
          id: 'default',
          label: '',
          code: `import os
import mcpspan

mcpspan.instrument(
    server,
    api_key=os.environ.get("MCPSPAN_API_KEY"),
    endpoint="${endpoint}",
)`,
        },
      ],
    },
    {
      id: 'go',
      label: 'Go',
      variants: [
        {
          id: 'official',
          label: 'Official Go SDK',
          code: `mcpsdk.Instrument(server, mcpspan.Config{
	APIKey:   os.Getenv("MCPSPAN_API_KEY"),
	Endpoint: "${endpoint}",
})
defer mcpspan.Shutdown(context.Background())`,
        },
        {
          id: 'mcp-go',
          label: 'mcp-go',
          code: `mcpgo.Instrument(s, mcpspan.Config{
	APIKey:   os.Getenv("MCPSPAN_API_KEY"),
	Endpoint: "${endpoint}",
})
defer mcpspan.Shutdown(context.Background())`,
        },
      ],
    },
    {
      id: 'csharp',
      label: 'C#',
      variants: [
        {
          id: 'default',
          label: '',
          code: `builder.Services.AddMcpServer()
    .WithMcpSpan(new McpSpanOptions
    {
        ApiKey = Environment.GetEnvironmentVariable("MCPSPAN_API_KEY"),
        Endpoint = "${endpoint}",
    });`,
        },
      ],
    },
    {
      id: 'java',
      label: 'Java',
      variants: [
        {
          id: 'default',
          label: '',
          code: `McpServer.sync(McpSpanJavaSdk.instrument(transport, ${javaBuilder}));`,
        },
      ],
    },
    {
      id: 'kotlin',
      label: 'Kotlin',
      variants: [
        {
          id: 'default',
          label: '',
          code: `McpServer.sync(McpSpanJavaSdk.instrument(transport, ${javaBuilder}))`,
          note: 'On the official MCP Java SDK, which Kotlin servers can use as they are.',
        },
      ],
    },
    {
      id: 'rust',
      label: 'Rust',
      variants: [
        {
          id: 'default',
          label: '',
          code: `let _mcpspan = mcpspan::configure(mcpspan::Options::default()
    .api_key(std::env::var("MCPSPAN_API_KEY")?)
    .endpoint("${endpoint}"));
let server = mcpspan::instrument(server).serve(stdio()).await?;`,
          note: 'In main: what is still queued is delivered when _mcpspan goes out of scope.',
        },
      ],
    },
    {
      id: 'ruby',
      label: 'Ruby',
      variants: [
        {
          id: 'default',
          label: '',
          code: `McpSpan.instrument(
  server,
  api_key: ENV["MCPSPAN_API_KEY"],
  endpoint: "${endpoint}",
)`,
        },
      ],
    },
    {
      id: 'php',
      label: 'PHP',
      variants: [
        {
          id: 'laravel',
          label: 'Laravel MCP',
          code: `MCPSPAN_API_KEY=your-key
MCPSPAN_ENDPOINT=${endpoint}`,
          note: 'In .env. Installing mcpspan/mcpspan does the rest.',
        },
        {
          id: 'official',
          label: 'Official PHP SDK',
          code: `McpSdk::instrument($builder, [
    'apiKey' => getenv('MCPSPAN_API_KEY'),
    'endpoint' => '${endpoint}',
]);`,
        },
      ],
    },
  ];
}
