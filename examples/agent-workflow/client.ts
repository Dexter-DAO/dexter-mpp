/**
 * Multi-Step Agent Workflow — Client
 *
 * An autonomous agent that executes a research workflow by chaining
 * three paid APIs in a loop:
 *   1. Research — search for documents on a topic
 *   2. Summarize — extract key findings from documents
 *   3. Generate — produce a structured report from findings
 *
 * The agent decides at each step whether to iterate (search again with
 * refined queries based on findings) or proceed to the next stage.
 * Each API call is paid with a session voucher — no chain interaction,
 * no settlement latency between steps.
 *
 * Demonstrates:
 *   - Agent paying multiple APIs in a tight decision loop
 *   - Per-step payment without blocking on chain confirmation
 *   - Total workflow cost tracked via cumulative vouchers
 *   - Comparison to charge mode (where each step adds ~1s latency)
 *
 * Run:
 *   SOLANA_PRIVATE_KEY=base58... npx tsx client.ts
 *   SOLANA_PRIVATE_KEY=base58... TOPIC="solana defi" ITERATIONS=3 npx tsx client.ts
 */

import { createKeyPairSignerFromBytes, getBase58Encoder } from "@solana/kit";
import { createSessionClient } from "@dexterai/mpp/client/session";

const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("Error: SOLANA_PRIVATE_KEY environment variable required");
  process.exit(1);
}

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:3001";
const TOPIC = process.env.TOPIC ?? "ai agents payments";
const MAX_ITERATIONS = Number(process.env.ITERATIONS ?? 3);
const DEPOSIT = process.env.DEPOSIT ?? "500000"; // 0.50 USDC

interface StepTiming {
  step: string;
  paymentMs: number;
  apiMs: number;
  totalMs: number;
}

async function main() {
  console.log("\n  Agent Workflow Client");
  console.log("  ══════════════════════════════════════════════════════════════");
  console.log(`  Topic:       ${TOPIC}`);
  console.log(`  Iterations:  ${MAX_ITERATIONS}`);
  console.log(`  Server:      ${SERVER_URL}`);
  console.log("  ══════════════════════════════════════════════════════════════\n");

  const keyBytes = getBase58Encoder().encode(PRIVATE_KEY);
  const signer = await createKeyPairSignerFromBytes(keyBytes);

  const session = createSessionClient({
    buyerWallet: signer.address,
    buyerSwigAddress: "",
    onProgress: (e) => {
      if (e.type === "opened") console.log(`  Session: ${e.channelId}\n`);
    },
  });

  // Onboard
  console.log("[setup] Onboarding...");
  const onboard = await session.onboard({ signer });
  console.log(`[setup] Swig: ${onboard.swigAddress}\n`);

  // Open session
  const challengeRes = await fetch(`${SERVER_URL}/api/workflow/challenge`);
  const challenge = await challengeRes.json();
  const recipient = challenge.services[0].recipient;

  const channel = await session.open({ seller: recipient, deposit: DEPOSIT });

  const timings: StepTiming[] = [];
  let totalPaid = 0n;
  let stepCount = 0;
  let allFindings: any[] = [];
  const workflowStart = Date.now();

  // ─── Workflow Loop ──────────────────────────────────────────────────────

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const query = iteration === 0
      ? TOPIC
      : `${TOPIC} ${allFindings.slice(-2).map((f: any) => f.finding?.split(":")[0]).join(" ")}`;

    // Step 1: Research
    stepCount++;
    const researchPrice = 5000n;
    totalPaid += researchPrice;

    const payStart = performance.now();
    const voucher1 = await session.pay(channel.channel_id, {
      amount: totalPaid.toString(),
      serverNonce: `research-${iteration}-${Date.now()}`,
    });
    const payMs1 = performance.now() - payStart;

    const apiStart1 = performance.now();
    const researchRes = await fetch(
      `${SERVER_URL}/api/research?q=${encodeURIComponent(query)}`,
      { headers: { "x-mpp-voucher": JSON.stringify(voucher1) } }
    );
    const research = await researchRes.json();
    const apiMs1 = performance.now() - apiStart1;

    timings.push({ step: `research-${iteration + 1}`, paymentMs: payMs1, apiMs: apiMs1, totalMs: payMs1 + apiMs1 });
    console.log(`  [${iteration + 1}.1] Research: "${query.slice(0, 40)}..." → ${research.results?.length || 0} docs (${(payMs1 + apiMs1).toFixed(0)}ms)`);

    // Step 2: Summarize
    stepCount++;
    const summarizePrice = 10000n;
    totalPaid += summarizePrice;

    const payStart2 = performance.now();
    const voucher2 = await session.pay(channel.channel_id, {
      amount: totalPaid.toString(),
      serverNonce: `summarize-${iteration}-${Date.now()}`,
    });
    const payMs2 = performance.now() - payStart2;

    const apiStart2 = performance.now();
    const summarizeRes = await fetch(`${SERVER_URL}/api/summarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-mpp-voucher": JSON.stringify(voucher2) },
      body: JSON.stringify({ documents: research.results || [], focusArea: TOPIC }),
    });
    const summary = await summarizeRes.json();
    const apiMs2 = performance.now() - apiStart2;

    timings.push({ step: `summarize-${iteration + 1}`, paymentMs: payMs2, apiMs: apiMs2, totalMs: payMs2 + apiMs2 });
    console.log(`  [${iteration + 1}.2] Summarize: ${summary.keyFindings?.length || 0} findings (${(payMs2 + apiMs2).toFixed(0)}ms)`);

    if (summary.keyFindings) {
      allFindings.push(...summary.keyFindings);
    }

    // Agent decides: iterate or proceed?
    if (iteration < MAX_ITERATIONS - 1 && (summary.keyFindings?.length || 0) < 3) {
      console.log(`  [${iteration + 1}.*] Agent: insufficient findings, iterating with refined query\n`);
      continue;
    }
  }

  // Step 3: Generate final report
  stepCount++;
  const generatePrice = 20000n;
  totalPaid += generatePrice;

  const payStart3 = performance.now();
  const voucher3 = await session.pay(channel.channel_id, {
    amount: totalPaid.toString(),
    serverNonce: `generate-final-${Date.now()}`,
  });
  const payMs3 = performance.now() - payStart3;

  const apiStart3 = performance.now();
  const generateRes = await fetch(`${SERVER_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-mpp-voucher": JSON.stringify(voucher3) },
    body: JSON.stringify({
      findings: allFindings,
      outputFormat: "report",
      topic: TOPIC,
    }),
  });
  const report = await generateRes.json();
  const apiMs3 = performance.now() - apiStart3;

  timings.push({ step: "generate", paymentMs: payMs3, apiMs: apiMs3, totalMs: payMs3 + apiMs3 });
  console.log(`\n  [final] Generate: ${report.output?.sections?.length || 0} sections (${(payMs3 + apiMs3).toFixed(0)}ms)`);

  // Close session
  console.log("\n  Closing session...");
  const settlement = await session.close(channel.channel_id);

  const workflowMs = Date.now() - workflowStart;

  // ─── Results ────────────────────────────────────────────────────────────

  const totalPaymentMs = timings.reduce((s, t) => s + t.paymentMs, 0);
  const totalApiMs = timings.reduce((s, t) => s + t.apiMs, 0);
  const chargeLatencyPerStep = 1000; // ~1s for on-chain settlement confirmation

  console.log("\n  ══════════════════════════════════════════════════════════════");
  console.log("  WORKFLOW RESULTS");
  console.log("  ══════════════════════════════════════════════════════════════");
  console.log("");
  console.log("  Step Timing:");
  for (const t of timings) {
    console.log(`    ${t.step.padEnd(16)} payment: ${t.paymentMs.toFixed(0).padStart(5)}ms  api: ${t.apiMs.toFixed(0).padStart(5)}ms  total: ${t.totalMs.toFixed(0).padStart(5)}ms`);
  }
  console.log("");
  console.log(`  Steps executed:        ${stepCount}`);
  console.log(`  Total workflow time:   ${(workflowMs / 1000).toFixed(1)}s`);
  console.log(`  Time in payments:      ${totalPaymentMs.toFixed(0)}ms (${((totalPaymentMs / workflowMs) * 100).toFixed(1)}% of workflow)`);
  console.log(`  Time in APIs:          ${totalApiMs.toFixed(0)}ms`);
  console.log(`  Total paid:            ${totalPaid} atomic ($${(Number(totalPaid) / 1e6).toFixed(4)} USDC)`);
  console.log(`  Settlement tx:         ${settlement.close_tx_signature}`);
  console.log("");
  console.log("  Charge Mode Comparison:");
  console.log(`  Session workflow:      ${(workflowMs / 1000).toFixed(1)}s (${stepCount} steps, payments add ${totalPaymentMs.toFixed(0)}ms)`);
  console.log(`  Charge mode estimate:  ${((workflowMs + stepCount * chargeLatencyPerStep) / 1000).toFixed(1)}s (each step waits ~1s for on-chain confirmation)`);
  console.log(`  Latency added by payments:`);
  console.log(`    Sessions:            ${totalPaymentMs.toFixed(0)}ms total (${(totalPaymentMs / stepCount).toFixed(0)}ms/step avg)`);
  console.log(`    Charge mode:         ${(stepCount * chargeLatencyPerStep)}ms total (${chargeLatencyPerStep}ms/step)`);
  console.log(`    Speedup:             ${(stepCount * chargeLatencyPerStep / totalPaymentMs).toFixed(0)}x faster payment verification`);
  console.log("");
  console.log("  The agent made autonomous payment decisions at each step.");
  console.log("  No human approval. No wallet popups. No chain latency between steps.");
  console.log("  ══════════════════════════════════════════════════════════════\n");

  // Print the actual report
  if (report.output?.sections) {
    console.log("  ── Generated Report ──────────────────────────────────────────\n");
    console.log(`  ${report.output.title}\n`);
    for (const section of report.output.sections) {
      console.log(`  ${section.heading}`);
      console.log(`  ${section.content}\n`);
    }
  }
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
