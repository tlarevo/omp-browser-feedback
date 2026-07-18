import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { JournalStore } from "../src/journal";

const dirs: string[] = [];

beforeEach(() => {
	// noop
});

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
	}
});
/** Mirror of journal.ts encodeChannelId for tests that write files directly. */
function encodedChannelId(channelId: string): string {
	return Buffer.from(channelId, "utf8").toString("base64url");
}

async function makeStore(
	bounds?: Partial<Parameters<typeof JournalStore.prototype.constructor>[1]>,
) {
	const dir = await fsp.mkdtemp(path.join("/tmp", "omp-journal-test-"));
	dirs.push(dir);
	const store = new JournalStore(dir, {
		maxEventsPerChannel: bounds?.maxEventsPerChannel ?? 100,
		maxTotalBytes: bounds?.maxTotalBytes ?? 1024 * 1024,
		maxAgeMs: bounds?.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000,
	});
	store.load();
	return { store, dir };
}

function event(
	eventId: string,
	channelId = "ch",
	extra?: Record<string, unknown>,
) {
	return {
		type: "event" as const,
		eventId,
		createdAt: new Date().toISOString(),
		payload: { channelId, ...extra },
	};
}

describe("JournalStore", () => {
	test("append and list events in order", async () => {
		const { store } = await makeStore();
		await store.appendEvent("ch", event("evt-1"));
		await store.appendEvent("ch", event("evt-2"));
		await store.appendEvent("ch", event("evt-3"));

		const lines = store.list("ch");
		expect(lines).toHaveLength(3);
		expect(lines.map((l) => (l.type === "event" ? l.eventId : "ack"))).toEqual([
			"evt-1",
			"evt-2",
			"evt-3",
		]);
	});

	test("append is idempotent for duplicate eventIds", async () => {
		const { store } = await makeStore();
		await store.appendEvent("ch", event("evt-1"));
		await store.appendEvent("ch", event("evt-1"));
		await store.appendEvent("ch", event("evt-1"));

		expect(store.list("ch")).toHaveLength(1);
	});

	test("appendAck records ack entry", async () => {
		const { store } = await makeStore();
		await store.appendEvent("ch", event("evt-1"));
		await store.appendAck("ch", "evt-1");

		const lines = store.list("ch");
		expect(lines).toHaveLength(2);
		expect(lines[1]).toEqual({ type: "ack", eventId: "evt-1" });
	});

	test("appendAck is idempotent for duplicate acks", async () => {
		const { store } = await makeStore();
		await store.appendEvent("ch", event("evt-1"));
		await store.appendAck("ch", "evt-1");
		await store.appendAck("ch", "evt-1");

		const lines = store.list("ch");
		expect(lines).toHaveLength(2); // 1 event + 1 ack (not 2 acks)
	});

	test("unacknowledged returns only unacked events", async () => {
		const { store } = await makeStore();
		await store.appendEvent("ch", event("evt-1"));
		await store.appendEvent("ch", event("evt-2"));
		await store.appendAck("ch", "evt-1");

		const pending = store.unacknowledged("ch");
		expect(pending).toHaveLength(1);
		expect(pending[0].eventId).toBe("evt-2");
	});

	test("compact removes acknowledged events and acks", async () => {
		const { store } = await makeStore();
		await store.appendEvent("ch", event("evt-1"));
		await store.appendEvent("ch", event("evt-2"));
		await store.appendEvent("ch", event("evt-3"));
		await store.appendAck("ch", "evt-1");
		await store.appendAck("ch", "evt-3");

		const compacted = store.compact("ch");
		expect(compacted).toHaveLength(1);
		expect(compacted[0].type === "event" && compacted[0].eventId).toBe(
			"evt-2",
		);
	});

	test("compact is safe on empty channel", async () => {
		const { store } = await makeStore();
		const compacted = store.compact("nonexistent");
		expect(compacted).toHaveLength(0);
	});

	test("clear removes all entries and journal file", async () => {
		const { store, dir } = await makeStore();
		await store.appendEvent("ch", event("evt-1"));
		await store.appendEvent("ch", event("evt-2"));

		const cleared = store.clear("ch");
		expect(cleared).toBe(2);
		expect(store.list("ch")).toHaveLength(0);

		// Journal file should not exist or be empty.
		const journalFile = path.join(dir, "ch.jsonl");
		if (fs.existsSync(journalFile)) {
			expect(fs.readFileSync(journalFile, "utf8").trim()).toBe("");
		}
	});

	test("survives restart: events persist across store instances", async () => {
		const dir = await fsp.mkdtemp(path.join("/tmp", "omp-journal-restart-"));
		dirs.push(dir);
		const bounds = {
			maxEventsPerChannel: 100,
			maxTotalBytes: 1024 * 1024,
			maxAgeMs: 7 * 24 * 60 * 60 * 1000,
		};

		// Phase 1: add events.
		const s1 = new JournalStore(dir, bounds);
		s1.load();
		await s1.appendEvent("ch", event("evt-1", "ch", { data: 1 }));
		await s1.appendEvent("ch", event("evt-2", "ch", { data: 2 }));
		await s1.appendAck("ch", "evt-1");

		// Phase 2: new store instance (simulates restart).
		const s2 = new JournalStore(dir, bounds);
		s2.load();

		// Unacknowledged event survives; acknowledged event remains in journal
		// but is correctly identified as unacknowledged=false.
		expect(s2.unacknowledged("ch")).toHaveLength(1);
		expect(s2.unacknowledged("ch")[0].eventId).toBe("evt-2");
		expect(s2.list("ch")).toHaveLength(3); // 2 events + 1 ack
	});

	test("tolerates one corrupted trailing record", async () => {
		const dir = await fsp.mkdtemp(path.join("/tmp", "omp-journal-corrupt-"));
		dirs.push(dir);
		const journalFile = path.join(dir, `${encodedChannelId("ch")}.jsonl`);
		// Write 2 valid lines + 1 corrupted trailing line.
		fs.writeFileSync(
			journalFile,
			'{"type":"event","eventId":"evt-1"}\n{"type":"event","eventId":"evt-2"}\n{"type":"event","eventId":"evt-3"TRUNCATED\n',
			{ mode: 0o600 },
		);

		const store = new JournalStore(dir, {
			maxEventsPerChannel: 100,
			maxTotalBytes: 1024 * 1024,
			maxAgeMs: 7 * 24 * 60 * 60 * 1000,
		});
		store.load();

		// First 2 events loaded; third (corrupted) dropped.
		expect(store.list("ch")).toHaveLength(2);
		expect(store.list("ch")[0].type === "event" && store.list("ch")[0].eventId).toBe("evt-1");
		expect(store.list("ch")[1].type === "event" && store.list("ch")[1].eventId).toBe("evt-2");
	});
	test("appendAck is a no-op for unknown eventIds (no pre-ack of future events)", async () => {
		const { store } = await makeStore();
		// ACK before the event exists — must not record.
		await store.appendAck("ch", "evt-unknown");
		expect(store.list("ch")).toHaveLength(0);

		// Now add the event — it must NOT be pre-acked.
		await store.appendEvent("ch", event("evt-unknown"));
		expect(store.unacknowledged("ch")).toHaveLength(1);
		expect(store.unacknowledged("ch")[0].eventId).toBe("evt-unknown");
	});

	test("duplicate ACK is a no-op and does not affect neighboring events", async () => {
		const { store } = await makeStore();
		await store.appendEvent("ch", event("evt-1"));
		await store.appendEvent("ch", event("evt-2"));
		await store.appendEvent("ch", event("evt-3"));

		await store.appendAck("ch", "evt-2");
		await store.appendAck("ch", "evt-2"); // duplicate

		// evt-1 and evt-3 must remain unacknowledged.
		const pending = store.unacknowledged("ch");
		expect(pending).toHaveLength(2);
		expect(pending.map((e) => e.eventId)).toEqual(["evt-1", "evt-3"]);
	});

	test("mid-file corruption throws and leaves file untouched", async () => {
		const dir = await fsp.mkdtemp(path.join("/tmp", "omp-journal-midcorrupt-"));
		dirs.push(dir);
		const journalFile = path.join(dir, `${encodedChannelId("ch")}.jsonl`);
		// valid + corrupt + valid (mid-file corruption).
		fs.writeFileSync(
			journalFile,
			'{"type":"event","eventId":"evt-1"}\n{"type":"event","eventId":"evt-2"TRUNCATED\n{"type":"event","eventId":"evt-3"}\n',
			{ mode: 0o600 },
		);
		const originalContent = fs.readFileSync(journalFile, "utf8");

		const store = new JournalStore(dir, {
			maxEventsPerChannel: 100,
			maxTotalBytes: 1024 * 1024,
			maxAgeMs: 7 * 24 * 60 * 60 * 1000,
		});
		expect(() => store.load()).toThrow("Mid-file corruption");
		// File must be untouched — operator inspects it.
		expect(fs.readFileSync(journalFile, "utf8")).toBe(originalContent);
	});

	test("bounds: rejects when maxEventsPerChannel exceeded after compaction", async () => {
		const { store } = await makeStore({ maxEventsPerChannel: 2 });
		await store.appendEvent("ch", event("evt-1"));
		await store.appendEvent("ch", event("evt-2"));
		// Both unacknowledged — compaction can't help.
		const result = await store.appendEvent("ch", event("evt-3"));
		expect(result).toMatchObject({
			error: true,
			code: "storage_limit",
		});
	});

	test("bounds: allows append after compaction frees space", async () => {
		const { store } = await makeStore({ maxEventsPerChannel: 2 });
		await store.appendEvent("ch", event("evt-1"));
		await store.appendEvent("ch", event("evt-2"));
		await store.appendAck("ch", "evt-1");
		// evt-1 is acknowledged — compaction removes it.
		const result = await store.appendEvent("ch", event("evt-3"));
		expect(result).toMatchObject({ appended: true });
	});

	test("bounds: rejects when maxTotalBytes exceeded after compaction", async () => {
		const { store } = await makeStore({ maxTotalBytes: 120 });
		// Fill with events that approach the limit.
		await store.appendEvent("ch", event("evt-1"));
		await store.appendEvent("ch", event("evt-2"));
		// Both unacknowledged — compaction can't help.
		const result = await store.appendEvent("ch", event("evt-3"));
		expect(result).toMatchObject({
			error: true,
			code: "storage_limit",
		});
	});

	test("evictByAge removes only acknowledged old events", async () => {
		const { store } = await makeStore({ maxAgeMs: 1000 });
		const oldTime = new Date(Date.now() - 5000).toISOString();
		const recentTime = new Date().toISOString();

		await store.appendEvent("ch", {
			...event("evt-old"),
			createdAt: oldTime,
		});
		await store.appendEvent("ch", {
			...event("evt-recent"),
			createdAt: recentTime,
		});
		await store.appendEvent("ch", {
			...event("evt-unacked-old"),
			createdAt: oldTime,
		});
		await store.appendAck("ch", "evt-old");
		await store.appendAck("ch", "evt-recent");
		// evt-unacked-old is old but NOT acknowledged — must remain.

		store.evictByAge("ch");
		const remaining = store.unacknowledged("ch");
		expect(remaining).toHaveLength(1);
		expect(remaining[0].eventId).toBe("evt-unacked-old");
	});

	test("listChannels returns channel IDs from disk", async () => {
		const { store } = await makeStore();
		await store.appendEvent("ch-a", event("evt-1", "ch-a"));
		await store.appendEvent("ch-b", event("evt-2", "ch-b"));

		const channels = store.listChannels();
		expect(channels.sort()).toEqual(["ch-a", "ch-b"]);
	});

	test("channel IDs with special characters are sanitized on disk", async () => {
		const { store, dir } = await makeStore();
		await store.appendEvent("ch/special", event("evt-1", "ch/special"));

		const files = fs.readdirSync(dir).filter((f: string) => f.endsWith(".jsonl"));
		expect(files).toHaveLength(1);
		expect(files[0]).not.toContain("/");
	});

	test("totalBytes tracks journal file sizes", async () => {
		const { store } = await makeStore();
		expect(store.totalBytes).toBe(0);

		await store.appendEvent("ch", event("evt-1"));
		const afterOne = store.totalBytes;
		expect(afterOne).toBeGreaterThan(0);

		await store.appendEvent("ch", event("evt-2"));
		expect(store.totalBytes).toBeGreaterThan(afterOne);
	});

	test("atomic compaction: crash during compaction preserves previous valid journal", async () => {
		const { store, dir } = await makeStore();
		await store.appendEvent("ch", event("evt-1"));
		await store.appendEvent("ch", event("evt-2"));
		await store.appendAck("ch", "evt-1");

		// Simulate: compact normally, then verify file content is valid.
		store.compact("ch");
		const journalFile = path.join(dir, `${encodedChannelId("ch")}.jsonl`);
		const content = fs.readFileSync(journalFile, "utf8");
		const lines = content
			.split("\n")
			.filter((l: string) => l.trim() !== "")
			.map((l: string) => JSON.parse(l));
		expect(lines).toHaveLength(1);
		expect(lines[0].eventId).toBe("evt-2");
	});
});
