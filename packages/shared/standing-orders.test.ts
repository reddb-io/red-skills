import { describe, expect, it } from "vitest";
import {
  briefWithStandingOrders,
  buildStandingOrdersSection,
  normalizeStandingOrders,
  readStandingOrdersFile,
  STANDING_ORDERS_ENABLED_KEY,
  STANDING_ORDERS_FILE,
  standingOrdersEnabled,
  standingOrdersFilePath,
} from "./standing-orders.js";

const ORDERS = "1. Never hand-edit the generated manifests.\n2. Land through the daemon.";

describe("the durable file's address", () => {
  it("lives in the project's own tracked `.red/` tree, not in a tmp lane", () => {
    expect(STANDING_ORDERS_FILE).toBe(".red/STANDING-ORDERS.md");
    expect(standingOrdersFilePath("/repo")).toBe("/repo/.red/STANDING-ORDERS.md");
    expect(standingOrdersFilePath("/repo/")).toBe("/repo/.red/STANDING-ORDERS.md");
  });

  it("is switched by one key under the dev plugin's AFK namespace", () => {
    expect(STANDING_ORDERS_ENABLED_KEY).toBe("afk.standing_orders.enabled");
  });
});

describe("standingOrdersEnabled", () => {
  it("defaults ON, because silence means `read the file if there is one`", () => {
    expect(standingOrdersEnabled(undefined)).toBe(true);
    expect(standingOrdersEnabled("")).toBe(true);
    expect(standingOrdersEnabled("true")).toBe(true);
  });

  it("is refused only by the literal false, the comparison every afk boolean uses", () => {
    expect(standingOrdersEnabled("false")).toBe(false);
    expect(standingOrdersEnabled("no")).toBe(true);
  });
});

describe("normalizeStandingOrders", () => {
  it("answers undefined for a file that exists but says nothing", () => {
    expect(normalizeStandingOrders(undefined)).toBeUndefined();
    expect(normalizeStandingOrders("")).toBeUndefined();
    expect(normalizeStandingOrders("   \n\n\t ")).toBeUndefined();
  });

  it("keeps the operator's own words, trimming only the edges", () => {
    expect(normalizeStandingOrders(`\n\n${ORDERS}\n\n`)).toBe(ORDERS);
  });
});

describe("buildStandingOrdersSection", () => {
  it("wraps the orders verbatim in the block the exit protocol names", () => {
    expect(buildStandingOrdersSection(ORDERS)).toBe(`<standing-orders>\n${ORDERS}\n</standing-orders>`);
  });

  it("omits the section entirely rather than emitting an empty one", () => {
    expect(buildStandingOrdersSection(undefined)).toBe("");
    expect(buildStandingOrdersSection("  ")).toBe("");
  });
});

describe("briefWithStandingOrders", () => {
  it("puts the orders FIRST, before the agent has chosen how to work", () => {
    expect(briefWithStandingOrders(ORDERS, "Implement #4141")).toBe(
      `<standing-orders>\n${ORDERS}\n</standing-orders>\n\nImplement #4141`,
    );
  });

  it("leaves a brief byte-for-byte unchanged when the project states no orders", () => {
    expect(briefWithStandingOrders(undefined, "Implement #4141")).toBe("Implement #4141");
  });
});

describe("readStandingOrdersFile", () => {
  it("reads the durable file at the project's own root", () => {
    const seen: string[] = [];
    const orders = readStandingOrdersFile({
      repoRoot: "/repo",
      enabled: undefined,
      read: (path) => {
        seen.push(path);
        return ORDERS;
      },
    });

    expect(seen).toEqual(["/repo/.red/STANDING-ORDERS.md"]);
    expect(orders).toBe(ORDERS);
  });

  it("does not read at all when the key says false", () => {
    const seen: string[] = [];
    const orders = readStandingOrdersFile({
      repoRoot: "/repo",
      enabled: "false",
      read: (path) => {
        seen.push(path);
        return ORDERS;
      },
    });

    expect(seen).toEqual([]);
    expect(orders).toBeUndefined();
  });

  it("answers undefined for an absent file, the state of every repo that never wrote one", () => {
    expect(readStandingOrdersFile({ repoRoot: "/repo", enabled: undefined, read: () => undefined }))
      .toBeUndefined();
  });
});
