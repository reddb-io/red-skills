import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = process.argv[2];
const ROOT = process.argv[3];

const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER],
  env: { ...process.env, CODE_NAV_ROOT: ROOT },
});
const client = new Client({ name: "test", version: "0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  console.log(`\n### ${name}(${JSON.stringify(args)})`);
  console.log(r.content.map((c) => c.text).join("\n"));
}

// 1. find Greet by name (no coordinates needed)
await call("workspace_symbols", { query: "Greet" });
// 2. outline of the file
await call("document_symbols", { file: "main.go" });
// 3. jump from the call site g.Greet() (line 16, char 15) to its definition
await call("goto_definition", { file: "main.go", line: 16, character: 15 });
// 4. all references to Greet (definition line 10)
await call("find_references", { file: "main.go", line: 10, character: 17 });
// 5. hover the call site for the signature
await call("hover", { file: "main.go", line: 16, character: 15 });

await client.close();
process.exit(0);
