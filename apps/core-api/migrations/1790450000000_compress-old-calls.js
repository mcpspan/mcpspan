/**
 * Raw calls and tool listings compressed once they are two weeks old.
 *
 * Raw rows are what an installation's disk fills with: ninety days of them by
 * default, against an hourly rollup three orders of magnitude smaller.
 * Compressed, a chunk of calls takes around a twelfth of the space (measured
 * on the demo's traffic: 232 MB down to 19 MB), and reads by time and server,
 * which is every read the dashboard makes, stay as fast.
 *
 * Grouped by server, since every query asks for one server, and ordered by
 * time within it. Fourteen days leaves the rollup's seven-day refresh window
 * and the current chunk uncompressed, so the rows still being written and
 * recounted are the ones left as they are. Calls that arrive late, and
 * redelivered ones, are still taken into a compressed chunk, once each.
 *
 * Compression is in TimescaleDB's community edition, which the image this
 * project pins is, and not in the Apache-only build some managed databases
 * offer. There, nothing is compressed and everything else works as before.
 *
 * JavaScript and outside a transaction for the reason the rollup migration
 * gives: TimescaleDB's policy calls do not all run inside one.
 */

const TABLES = ['tool_calls', 'resource_calls', 'prompt_calls', 'tool_listings'];

export const up = (pgm) => {
  pgm.noTransaction();

  for (const table of TABLES) {
    pgm.sql(`
      DO $$
      BEGIN
        IF current_setting('timescaledb.license', true) IS DISTINCT FROM 'timescale' THEN
          RAISE NOTICE 'TimescaleDB without compression (license %): ${table} stays uncompressed',
            current_setting('timescaledb.license', true);
          RETURN;
        END IF;
        ALTER TABLE ${table} SET (
          timescaledb.compress,
          timescaledb.compress_segmentby = 'server_id',
          timescaledb.compress_orderby = 'occurred_at DESC'
        );
        PERFORM add_compression_policy('${table}', compress_after => INTERVAL '14 days', if_not_exists => true);
      END
      $$
    `);
  }
};

export const down = (pgm) => {
  pgm.noTransaction();

  for (const table of TABLES) {
    pgm.sql(`
      DO $$
      BEGIN
        IF current_setting('timescaledb.license', true) IS DISTINCT FROM 'timescale' THEN
          RETURN;
        END IF;
        PERFORM remove_compression_policy('${table}', if_exists => true);
        PERFORM decompress_chunk(chunk, true) FROM show_chunks('${table}') AS chunk;
        ALTER TABLE ${table} SET (timescaledb.compress = false);
      END
      $$
    `);
  }
};
