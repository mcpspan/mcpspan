import Link from 'next/link';

import type { ToolListing as ToolListingData } from '../lib/api';
import { formatBytes } from '../lib/diagnosis';
import { formatCount } from '../lib/format';
import { type Params, withParams } from '../lib/query';
import { BreakableName } from './breakable-name';
import { InfoTip } from './info-tip';
import { OffsetPager } from './pager';
import { ParamSelect } from './param-select';

/** A common rule of thumb for English text and JSON; the real count depends on the model. */
const BYTES_PER_TOKEN = 4;

export function tokens(bytes: number): string {
  return `≈ ${formatCount(Math.round(bytes / BYTES_PER_TOKEN))}`;
}

/**
 * What agents are shown and what they use (contract, 3.11).
 *
 * Every session starts by reading the definitions of every tool the server
 * lists, called or not, so the list has a cost before anything happens; and a
 * tool shown in hundreds of sessions and called in none is invisible among
 * the calls. Least used first, since those are the rows to act on: reword
 * the description, or drop the tool and its cost with it.
 */
export function ToolListing({ data, params }: { data: ToolListingData; params: Params }) {
  const neverUsed = data.neverUsed;

  return (
    <>
      {data.latest === null ? null : (
        <p className="mb-4 flex items-start gap-1.5 text-sm">
          <span>
            Each session starts by reading {tokens(data.latest.bytes)} tokens of tool definitions:{' '}
            {formatCount(data.latest.tools)} {data.latest.tools === 1 ? 'tool' : 'tools'},{' '}
            <span className="whitespace-nowrap">{formatBytes(data.latest.bytes)}</span>.
            {neverUsed === 0 ? null : (
              <>
                {' '}
                {formatCount(neverUsed)} of them {neverUsed === 1 ? 'was' : 'were'} never called in the{' '}
                {formatCount(data.sessions)} {data.sessions === 1 ? 'session' : 'sessions'} shown {neverUsed === 1 ? 'it' : 'them'}.
              </>
            )}
          </span>
          <InfoTip id="listing-tokens" about="the token count">
            Estimated at four bytes a token from each definition's name, title, description and input schema, as the
            server lists them. The exact count depends on the model and on how the client presents the tools. Tools left out of mcpspan are not counted.
          </InfoTip>
        </p>
      )}

      {data.total <= 1 ? null : (
        <div className="mb-3">
          <ParamSelect
            params={params}
            name="listingOrder"
            label="Order"
            choices={[
              { value: 'least-used', label: 'Least used first' },
              { value: 'largest', label: 'Largest first' },
              { value: 'name', label: 'By name' },
            ]}
            resets={['listingOffset']}
            hash="#listing"
          />
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-ink-muted">
              <th scope="col" className="pb-2 text-left font-medium">
                Tool
              </th>
              {/* On a phone the number of sessions shown goes under the share instead. */}
              <th scope="col" className="hidden pb-2 pl-4 text-right font-medium sm:table-cell">
                <span className="inline-flex items-center gap-1">
                  Shown in
                  <InfoTip id="listing-shown" about="shown in">
                    Sessions whose client was sent this tool in the list of tools, whether or not it then called it.
                  </InfoTip>
                </span>
              </th>
              <th scope="col" className="pb-2 pl-4 text-right font-medium">
                <span className="inline-flex items-center gap-1">
                  Used in
                  <InfoTip id="listing-used" about="used in">
                    Of the sessions shown the tool, the share that called it at least once. Never: shown in every one of
                    them and not called once.
                  </InfoTip>
                </span>
              </th>
              <th scope="col" className="pb-2 pl-4 text-right font-medium">
                <span className="inline-flex items-center gap-1">
                  Tokens
                  <InfoTip id="listing-tool-tokens" about="tokens">
                    What the tool's definition takes in the model's context, every session, called or not. Estimated at
                    four bytes a token from its name, title, description and input schema.
                  </InfoTip>
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.tools.map((tool) => {
              const share = tool.sessions === 0 ? 0 : tool.usedSessions / tool.sessions;

              return (
                <tr key={tool.name} className="border-t border-border">
                  <th scope="row" className="py-2 text-left font-normal">
                    <Link
                      href={`/tool${withParams(
                        { serverId: params['serverId'], range: params['range'] },
                        { toolName: tool.name },
                      )}`}
                      className="font-mono text-xs outline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ink"
                    >
                      <BreakableName name={tool.name} />
                    </Link>
                    {tool.listed ? null : <span className="block text-[11px] text-ink-muted">No longer listed</span>}
                  </th>
                  <td className="hidden py-2 pl-4 text-right tabular-nums text-ink-muted sm:table-cell">
                    {formatCount(tool.sessions)}
                  </td>
                  <td
                    className={`py-2 pl-4 text-right tabular-nums ${
                      tool.usedSessions === 0 ? 'text-status-warning-ink' : ''
                    }`}
                  >
                    {tool.usedSessions === 0 ? 'Never' : `${Math.round(share * 100)}%`}
                    <span className="block text-[11px] whitespace-nowrap text-ink-muted">
                      {formatCount(tool.usedSessions)} of {formatCount(tool.sessions)}
                    </span>
                  </td>
                  <td className="py-2 pl-4 text-right tabular-nums text-ink-muted">{tokens(tool.bytes)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <OffsetPager
        params={params}
        name="listingOffset"
        offset={data.offset}
        limit={data.limit}
        hasMore={data.hasMore}
        total={data.total}
        hash="#listing"
      />
    </>
  );
}
