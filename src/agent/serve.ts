/* Binding the agent app to a socket. */

import { serve } from "h3";
import { type AgentContext, createAgentApp } from "./app.ts";
import { parseHostPort } from "./config.ts";

/** A listening agent. */
export interface AgentServer {
  /** Origin the agent answers on, without a trailing slash: `http://127.0.0.1:7400`. */
  url: string;
  /** Stops the listener and resolves once it is closed. */
  close(): Promise<void>;
}

/**
 * Starts the agent API on `config.node.listen`, binding exactly that host and
 * nothing more.
 *
 * These routes command the node, so the listener must only ever face a trusted
 * network — loopback, or an interface reachable by the other nodes alone. Which
 * one it is, is the operator's choice, and it is made in the configuration.
 */
export async function startAgent(agent: AgentContext): Promise<AgentServer> {
  const { host, port } = parseHostPort(agent.config.node.listen, "node.listen");

  const server = serve(createAgentApp(agent), {
    hostname: host,
    port,
    /* The caller owns both the log line and the shutdown path — it has processes
       of its own to stop — so the server neither announces itself nor traps signals. */
    silent: true,
    gracefulShutdown: false,
  });
  await server.ready();

  return {
    /* Trimmed of the trailing slash the server reports, so a caller can append a path. */
    url: (server.url ?? `http://${agent.config.node.listen}`).replace(/\/$/, ""),
    async close(): Promise<void> {
      /* Idle keep-alive connections are dropped along with the listener; left
         open they would hold the socket, and the process, alive indefinitely. */
      await server.close(true);
    },
  };
}
