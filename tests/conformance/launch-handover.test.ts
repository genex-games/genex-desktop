/** A game's first message from home: when it waits, asks for a sign-in, sends, or goes to the composer. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HandoverStep,
  HeldState,
  handoverStep,
  heldAfterSend,
  SendOutcome,
} from "../../src/renderer/chat/use-launch-handover.ts";

const ready = { enginesRead: true, hasModel: true, needsSignIn: false };

describe("a game's first message from home", () => {
  it("waits while the models and sign-ins are still being read", () => {
    assert.equal(handoverStep(HeldState.Waiting, { ...ready, enginesRead: false }), HandoverStep.Wait);
  });

  it("sends once it can, and never starts a sign-in by itself", () => {
    assert.equal(handoverStep(HeldState.Waiting, ready), HandoverStep.Send);
    assert.equal(handoverStep(HeldState.Waiting, { ...ready, needsSignIn: true }), HandoverStep.SignIn);
  });

  it("sends by itself once a signed-out subscription is signed in again", () => {
    assert.equal(handoverStep(HeldState.SignedOut, { ...ready, needsSignIn: true }), HandoverStep.SignIn);
    assert.equal(handoverStep(HeldState.SignedOut, ready), HandoverStep.Send);
  });

  it("waits for Try again after a failed send, instead of sending in a loop", () => {
    assert.equal(handoverStep(HeldState.Failed, ready), HandoverStep.Wait);
  });

  it("hands the words to the composer when there is no model at all, where Connect AI model is", () => {
    assert.equal(handoverStep(HeldState.Waiting, { ...ready, hasModel: false }), HandoverStep.ToComposer);
  });
});

describe("a held message after its send ends", () => {
  it("is gone once sent, and offers Try again after a failure", () => {
    assert.equal(heldAfterSend(SendOutcome.Sent, { here: true, needsSignIn: false }), null);
    assert.equal(heldAfterSend(SendOutcome.Failed, { here: false, needsSignIn: false }), HeldState.Failed);
  });

  it("asks for the sign-in in its own chat, or hands the words to that chat's composer", () => {
    assert.equal(heldAfterSend(SendOutcome.NotSent, { here: true, needsSignIn: true }), HeldState.SignedOut);
    assert.equal(heldAfterSend(SendOutcome.NotSent, { here: true, needsSignIn: false }), "composer");
  });

  it("waits in its own chat when the person moved on, never deciding by another chat's sign-in or composer", () => {
    assert.equal(heldAfterSend(SendOutcome.NotSent, { here: false, needsSignIn: false }), HeldState.Waiting);
    assert.equal(heldAfterSend(SendOutcome.NotSent, { here: false, needsSignIn: true }), HeldState.Waiting);
  });
});
