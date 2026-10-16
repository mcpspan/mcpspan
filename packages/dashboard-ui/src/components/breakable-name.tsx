import { Fragment } from 'react';

/**
 * A tool's name that may wrap after each underscore, dot, slash or hyphen, so a narrow column breaks
 * `get_flight_status` as `get_flight_` and `status` rather than in the middle of a word. The breaks are `<wbr>`,
 * which a copy of the name leaves out.
 */
export function BreakableName({ name }: { name: string }) {
  const parts = name.split(/(?<=[_./-])/);

  return (
    <>
      {parts.map((part, index) => (
        // The parts of one name, in order, never reordered.
        <Fragment key={index}>
          {part}
          {index < parts.length - 1 ? <wbr /> : null}
        </Fragment>
      ))}
    </>
  );
}
