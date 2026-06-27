#!/usr/bin/env bun
import { generateBrowserBrokerToken } from "./auth";
import { createBrowserBrokerServer } from "./server";

const portArg = process.argv.find(arg => arg.startsWith("--port="));
const port = portArg ? Number(portArg.slice("--port=".length)) : 4317;
const authToken = process.env.OMP_BROWSER_BROKER_TOKEN ?? generateBrowserBrokerToken();

const server = await createBrowserBrokerServer({ host: "127.0.0.1", port, authToken });

process.stdout.write(`OMP browser broker listening on ${server.baseUrl}\n`);
