#!/usr/bin/env bun
import { PREFERRED_BROWSER_BROKER_PORT } from "@oh-my-pi/browser-protocol";
import { generateBrowserBrokerToken } from "./auth";
import { createBrowserBrokerServer } from "./server";

const portArg = process.argv.find((arg) => arg.startsWith("--port="));
const port = portArg
	? Number(portArg.slice("--port=".length))
	: PREFERRED_BROWSER_BROKER_PORT;
const authToken =
	process.env.OMP_BROWSER_BROKER_TOKEN ?? generateBrowserBrokerToken();

const server = await createBrowserBrokerServer({
	host: "127.0.0.1",
	port,
	authToken,
});

process.stdout.write(`OMP browser broker listening on ${server.baseUrl}\n`);
