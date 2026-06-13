import pg from "pg";

export interface Listener {
  close: () => Promise<void>;
}

/** Dedicated connection subscribed to a NOTIFY channel; reconnects are the caller's concern. */
export async function listen(
  connectionString: string,
  channel: string,
  onNotification: (payload: string) => void,
): Promise<Listener> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  client.on("notification", (msg) => {
    if (msg.channel === channel) onNotification(msg.payload ?? "");
  });
  await client.query(`listen ${client.escapeIdentifier(channel)}`);
  return { close: () => client.end() };
}
