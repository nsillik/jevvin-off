/**
 * Minimal Jev (TypeSafe System One) test harness.
 *
 * One state (a support ticket), three judgments about it in a single request,
 * then a decision made in code from the typed answers.
 *
 * Usage:
 *   bun run examples/quickstart.ts                     # built-in sample ticket
 *   bun run examples/quickstart.ts "your text here"    # your own text
 *   cat ticket.txt | bun run examples/quickstart.ts -  # text from stdin
 *
 * Requires TYPESAFE_API_KEY. Bun loads .env automatically (copy .env.example);
 * under node use: node --env-file=.env examples/quickstart.ts
 */

import process from "node:process";
import { choice, noul, score, TypeSafeClient, TypeSafeError } from "@typesafe-ai/sdk";
import type { SystemOneResult } from "@typesafe-ai/sdk";

const SAMPLE_TICKET =
  "Hi, I've been trying to connect my Stripe account for 3 days and it keeps " +
  "failing. I'm losing sales. Please help ASAP.";

// Confidence below this means we don't act on the answer automatically.
const REVIEW_THRESHOLD = 0.6;

async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const message = (args[0] === "-" ? await readStdin() : args.join(" ") || SAMPLE_TICKET).trim();

  if (!message) {
    console.error("no state to evaluate: pass text as an argument or pipe it on stdin");
    return 2;
  }

  // State is the material to judge. An object keeps related parts named.
  const state = {
    ticket: { channel: "email", message },
    customer: { plan: "growth", tenure_months: 14 },
  };

  // Every question sees the same state and is answered independently.
  const questions = {
    department: choice("Which team should handle this ticket?", {
      billing: "Payment, invoice, or subscription problems",
      technical: "Bugs, outages, broken integrations",
      sales: "Pricing, upgrades, new accounts",
      other: "Nothing above fits",
    }),
    frustration: score("How frustrated does the customer appear?", [
      "Calm, just stating facts",
      "Frustrated but civil",
      "Very angry, strong language",
    ]),
    is_urgent: noul("Does the message convey urgency or time-sensitivity?", {
      true: "Explicitly time-sensitive or blocking their work",
      false: "No urgency expressed",
    }),
  };

  let response: SystemOneResult<typeof questions>;
  try {
    response = await new TypeSafeClient().systemOne({ state, questions });
  } catch (error) {
    if (error instanceof TypeSafeError) {
      console.error(`request failed: ${error.message}`);
      return 1;
    }
    throw error;
  }

  console.log(`model=${response.model}`);
  console.log(
    `tokens: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out\n`,
  );

  const { department, frustration, is_urgent: urgent } = response.answers;

  console.log(`department  = ${department.choice}  (confidence ${department.confidence.toFixed(3)})`);
  for (const [option, probability] of Object.entries(department.probabilities).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`              ${option.padEnd(10)} ${probability.toFixed(3)}`);
  }

  console.log(`frustration = ${frustration.score.toFixed(3)}  (confidence ${frustration.confidence.toFixed(3)})`);
  for (const [level, probability] of Object.entries(frustration.probabilities)) {
    const description = frustration.legend[level as keyof typeof frustration.legend];
    console.log(`              ${description.padEnd(30)} ${probability.toFixed(3)}`);
  }

  console.log(`is_urgent   = ${urgent.noul.toFixed(3)} (probability of yes)`);

  // The model supplies judgments; the routing rules stay in code.
  console.log();
  if (department.confidence < REVIEW_THRESHOLD) {
    console.log(`route: human review (department confidence ${department.confidence.toFixed(3)})`);
  } else {
    console.log(`route: ${department.choice} queue`);
  }
  console.log(`priority: ${urgent.noul >= 0.8 ? "high" : "normal"}`);
  if (frustration.score >= 1.5) {
    console.log("flag: upset customer, consider a direct reply");
  }

  return 0;
}

process.exit(await main());
