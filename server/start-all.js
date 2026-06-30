import { spawn } from "node:child_process";

const toPort = (value, fallback) => {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const metaPort = toPort(process.env.WHATSAPP_SERVER_PORT_META, 5050);
const checkoutPort = toPort(process.env.CHECKOUT_SERVER_PORT, 5051);
const painelAgentPort = toPort(process.env.PANEL_AGENT_PORT, 5052);
const metaMaxOldSpaceMb = toPort(process.env.WHATSAPP_META_MAX_OLD_SPACE_MB, 4096);

const isPainelAgentBrokerDisabled =
  String(process.env.PANEL_AGENT_BROKER_DISABLED || "").toLowerCase() === "true";

let isShuttingDown = false;
const managedChildren = new Set();

const shutdown = () => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  for (const child of managedChildren) {
    if (!child.killed) {
      child.kill();
    }
  }
};

const spawnServer = ({ name, script, port, extraEnv = {}, nodeArgs = [] }) => {
  const child = spawn("node", [...nodeArgs, script], {
    env: {
      ...process.env,
      ...extraEnv,
      WHATSAPP_SERVER_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const prefix = `[${name}] `;

  child.stdout.on("data", (chunk) => {
    process.stdout.write(
      chunk
        .toString()
        .split(/\r?\n/)
        .map((line, index, arr) =>
          line.length || index < arr.length - 1 ? `${prefix}${line}` : "",
        )
        .join("\n"),
    );
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(
      chunk
        .toString()
        .split(/\r?\n/)
        .map((line, index, arr) =>
          line.length || index < arr.length - 1 ? `${prefix}${line}` : "",
        )
        .join("\n"),
    );
  });

  managedChildren.add(child);

  child.on("error", (error) => {
    console.error(`${prefix}falha ao iniciar: ${error.message || error}`);
    if (!isShuttingDown) {
      shutdown();
      process.exit(1);
    }
  });

  child.on("exit", (code, signal) => {
    managedChildren.delete(child);

    if (isShuttingDown) {
      return;
    }

    const exitDetail = signal ? `sinal ${signal}` : `codigo ${code}`;
    console.error(`${prefix}encerrado com ${exitDetail}`);

    // Keep the stack consistent: if one managed child dies unexpectedly,
    // terminate the parent so systemd restarts the full app.
    shutdown();
    process.exit(code ?? 1);
  });

  return child;
};

const meta = spawnServer({
  name: "meta",
  script: "server/whatsapp-server.js",
  port: metaPort,
  nodeArgs: [`--max-old-space-size=${metaMaxOldSpaceMb}`],
  extraEnv: {
    WHATSAPP_BAILEYS_API_URL: "",
  },
});

const checkout = spawnServer({
  name: "checkout",
  script: "server/checkout-server.js",
  port: checkoutPort,
});

const painelAgentBroker = !isPainelAgentBrokerDisabled
  ? spawnServer({
    name: "painel-agent",
    script: "server/painel-agent-broker.js",
    port: painelAgentPort,
    extraEnv: {
      PANEL_AGENT_PORT: String(painelAgentPort),
    },
  })
  : null;

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});

process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});


