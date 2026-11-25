#include "GenexCore/GenexModels.h"

#include <string>
#include <string_view>

// The platform's sentences, code by code: embed-sdk's generationErrorMessage, in its order. A native build that calls
// Genex itself (GenexModelsHttp) gets the server's own codes, and a player reads the same sentence a web game shows.
// The shared vectors hold every row equal to the SDK's (`native.sentences` in models-bridge.json; genex_models_check
// and the Genex.Multiplayer.Models automation test read them), so a sentence is changed there first and copied here.
//
// A non-ASCII character is written as its UTF-8 bytes. None is followed by a hexadecimal digit, which a `\x` escape
// would swallow; write one that is as two adjacent literals.

namespace genex::models {

namespace {

/** One sentence, and the codes that read as it, separated by single spaces. */
struct ModelsSentence {
  std::string_view codes;
  std::string_view text;
};

constexpr std::string_view kModelsGeneralSentence = "Generation isn\xE2\x80\x99t available right now. Try again in a moment.";

constexpr ModelsSentence kModelsSentences[] = {
    {"unknown unknown_execution provider_outcome_unknown",
     "We don\xE2\x80\x99t know how this one ended yet \xE2\x80\x94 it is still being settled. Check back in a moment."},
    {"wait_timeout",
     "This is taking longer than usual. It is still running \xE2\x80\x94 check back in a moment."},
    {"insufficient_credits",
     "You don\xE2\x80\x99t have enough Genex credits for this request. Top up on Genex and try again."},
    {"credits_unverified",
     "Verify your email on Genex to use your credits here."},
    {"generation_paused",
     "Genex has paused generation for now. Try again later."},
    {"payer_busy",
     "Genex is busy with your account for a moment. Try again shortly."},
    {"insufficient_balance",
     "There isn\xE2\x80\x99t enough in your Genex wallet for this request."},
    {"grant_insufficient_funds",
     "Your budget paused because your Genex credits ran low. Top them up and it picks up again."},
    {"grant_limit_reached",
     "This budget has reached the limit you set. Set up a new one to keep going."},
    {"grant_stopped",
     "This budget was stopped. Set up a new one to keep going."},
    {"grant_expired",
     "This budget has ended. Set up a new one to keep going."},
    {"grant_not_active grant_not_found",
     "There is no budget running for this. Set one up to keep going."},
    {"grant_price_unreasonable",
     "This asked to charge more for one request than your approval allows, so nothing was charged."},
    {"grant_concurrency",
     "As many requests are running as your budget allows at once. Wait for one to finish."},
    {"grant_rate_limited",
     "Requests are coming too quickly for this budget. Wait a moment and try again."},
    {"grant_already_active",
     "A budget is already running here. Stop it on Genex before setting up another."},
    {"room_calls_unavailable",
     "Shared AI in multiplayer rooms isn\xE2\x80\x99t available here yet."},
    {"grant_not_shareable",
     "This budget wasn\xE2\x80\x99t approved for the game\xE2\x80\x99s multiplayer server. Set up a new one that says so."},
    {"room_not_found",
     "That multiplayer room isn\xE2\x80\x99t running any more."},
    {"room_funding_unsupported",
     "A budget on your own Claude or ChatGPT plan can\xE2\x80\x99t be used by the game\xE2\x80\x99s multiplayer server. Use one paid from Genex credits."},
    {"lend_not_found",
     "This budget isn\xE2\x80\x99t lent to that room."},
    {"external_grant_active",
     "A budget on your own plan is already running. Stop it on Genex before setting up another."},
    {"invalid_grant_limit",
     "That limit is outside the range Genex offers. Choose one on the slider."},
    {"sponsor_not_available sponsor_terms_mismatch",
     "This game isn\xE2\x80\x99t covering model use right now."},
    {"sponsor_exhausted sponsor_stopped sponsor_expired",
     "What this game\xE2\x80\x99s creator set aside for model use has run out or ended. Nothing was charged to you."},
    {"sponsor_player_limit_reached sponsor_address_limit_reached",
     "You\xE2\x80\x99ve used what this game\xE2\x80\x99s creator covers for today. It starts again tomorrow."},
    {"sponsor_rate_limited",
     "Requests are coming too quickly right now. Wait a moment and try again."},
    {"sponsor_sign_in_required",
     "Sign in to Genex to use what this game\xE2\x80\x99s creator covers."},
    {"sponsor_email_unverified",
     "Verify your email on Genex to use what this game\xE2\x80\x99s creator covers."},
    {"judge_requires_grant",
     "This game\xE2\x80\x99s quick checks run under a budget you approve. Set one up to keep going."},
    {"judge_not_enabled",
     "This budget doesn\xE2\x80\x99t cover the game\xE2\x80\x99s quick checks. Set up a new one to keep going."},
    {"judge_requires_coins judge_requires_credits",
     "The game\xE2\x80\x99s quick checks are paid from your Genex credits, not your own plan."},
    {"invalid_judge_terms",
     "This budget request isn\xE2\x80\x99t valid, so nothing was requested."},
    {"judge_period_limit",
     "The game\xE2\x80\x99s quick checks have reached the most your budget allows for now. They pick up again shortly."},
    {"judge_busy",
     "The game\xE2\x80\x99s quick checks are busy right now. Try again in a moment."},
    {"judge_paused",
     "The game\xE2\x80\x99s quick checks are paused for now. Try again later."},
    {"voice_requires_grant",
     "This game\xE2\x80\x99s voice features run under a budget you approve. Set one up to keep going."},
    {"voice_not_enabled",
     "This budget doesn\xE2\x80\x99t cover the game\xE2\x80\x99s voice features. Set up a new one to keep going."},
    {"voice_requires_credits",
     "The game\xE2\x80\x99s voice features are paid from your Genex credits, not your own plan."},
    {"voice_not_found",
     "That voice isn\xE2\x80\x99t available here."},
    {"voice_busy",
     "The game\xE2\x80\x99s voice features are busy right now. Try again in a moment."},
    {"voice_paused",
     "The game\xE2\x80\x99s voice features are paused for now. Try again later."},
    {"text_too_long",
     "That line is too long to speak in one go. Shorten it and try again."},
    {"audio_invalid",
     "That recording couldn\xE2\x80\x99t be read. Try recording again."},
    {"audio_too_long",
     "That recording is too long. Keep it shorter and try again."},
    {"audio_too_short",
     "That recording was too short to make out. Speak a little longer and try again."},
    {"microphone_denied",
     "The microphone isn\xE2\x80\x99t allowed for this game. Allow it in your browser to talk, or type instead."},
    {"microphone_unavailable",
     "No microphone could be used. Check that one is connected, or type instead."},
    {"request_aborted",
     "This stopped before its answer arrived. If it had already started, it is still charged as usual."},
    {"stream_requires_grant",
     "Live replies run under a budget you approve. Set one up to keep going."},
    {"stream_aborted",
     "This reply stopped showing, but it is still finishing and is charged as usual. Check back in a moment."},
    {"waiting_for_plan",
     "Your own plan is at its rate limit right now. This resumes on its own once the limit resets."},
    {"external_request_active",
     "Finish your current request on your own plan before starting another."},
    {"external_not_allowed",
     "This game only generates through Genex."},
    {"external_unavailable",
     "Your own plan can\xE2\x80\x99t answer this right now."},
    {"player_update_required",
     "The Genex player watcher on your computer is out of date. Update it and try again."},
    {"popup_blocked",
     "Your browser blocked the Genex approval window. Allow pop-ups for this page and try again."},
    {"no_player_session unauthorized guest_no_wallet",
     "Sign in to Genex to use this."},
    {"player_wallet_required",
     "Sign in to Genex to use this. Only the game\xE2\x80\x99s owner can use this on a test build."},
    {"session_revoked",
     "Your Genex session ended. Sign in again to continue."},
    {"untrusted_parent invalid_dashboard_origin forbidden_origin credential_scope",
     "This page can\xE2\x80\x99t reach Genex safely, so nothing was requested."},
    {"native_unsupported",
     "In-game generation isn\xE2\x80\x99t available in the app yet."},
    {"local_test_unsupported",
     "In-game generation doesn\xE2\x80\x99t run in local test mode."},
    {"staging_no_generation",
     "Only the game\xE2\x80\x99s owner can use this on a test build."},
    {"quote_expired generation_expired expired",
     "This request expired before it was approved. Try again."},
    {"quote_changed quote_mismatch offering_changed",
     "The price changed. Start this again to see the new offer."},
    {"billing_policy_mismatch billing_policy_required billing_policy_unsupported",
     "These terms need a fresh review on Genex. Reload the page and try again."},
    {"funding_mismatch funding_conflict",
     "That payment option doesn\xE2\x80\x99t match this request. Start it again."},
    {"invalid_declared_price invalid_estimate_coins invalid_max_credits",
     "This request\xE2\x80\x99s spending limit isn\xE2\x80\x99t valid, so nothing was charged."},
    {"model_not_allowed",
     "This budget doesn\xE2\x80\x99t cover that model. Choose one it does."},
    {"model_not_available offering_unavailable workflow_unavailable runtime_models_unavailable",
     "That model isn\xE2\x80\x99t available here. Choose another."},
    {"provider_budget_insufficient estimate_exceeds_provider_budget",
     "This request is too large for its approved budget. Make it smaller and try again."},
    {"provider_budget_exceeded provider_budget_exhausted workflow_provider_budget_exhausted budget_exhausted budget_limit runtime_budget_exhausted provider_token_limit",
     "The model ran out of room before a usable answer was ready. The attempt is still charged."},
    {"request_too_large prompt_too_large schema_too_large",
     "That request is too long. Shorten it and try again."},
    {"output_tokens_too_large",
     "This request asks for a longer answer than Genex allows. Ask for a shorter one."},
    {"invalid_request invalid_schema invalid_max_output_tokens invalid_messages unsupported_parameter",
     "This request wasn\xE2\x80\x99t something Genex could accept."},
    {"generation_limit",
     "As many requests are running as Genex allows at once. Wait for one to finish."},
    {"generation_not_found",
     "That request no longer exists."},
    {"idempotency_conflict",
     "That request was already started with different details."},
    {"rejected invalid_output validation_failed invalid_provider_response",
     "The answer didn\xE2\x80\x99t match what this game asked for."},
    {"content_blocked",
     "That isn\xE2\x80\x99t allowed here, so nothing was shown. Try saying it another way."},
    {"player_stopped game_stopped operator_stopped",
     "This request was stopped before it ran, so nothing was charged for it."},
    {"admission_revoked canceled",
     "This request was stopped. Work that had already started is still charged."},
    {"account_erased",
     "This request was stopped because the account was erased."},
    {"provider_failed provider_unavailable provider_response_unavailable provider_response_too_large context_unavailable",
     "The model couldn\xE2\x80\x99t finish this request."},
};

/** Whether `codes` (space separated) names `code` exactly. */
bool ModelsNamesCode(std::string_view codes, std::string_view code) {
  while (!codes.empty()) {
    const std::size_t space = codes.find(' ');
    if (codes.substr(0, space) == code) return true;
    if (space == std::string_view::npos) break;
    codes.remove_prefix(space + 1);
  }
  return false;
}

const ModelsSentence* ModelsSentenceFor(std::string_view code) {
  if (code.empty() || code.find(' ') != std::string_view::npos) return nullptr;
  for (const ModelsSentence& row : kModelsSentences) {
    if (ModelsNamesCode(row.codes, code)) return &row;
  }
  return nullptr;
}

}  // namespace

bool HasErrorSentence(std::string_view code) { return ModelsSentenceFor(code) != nullptr; }

bool IsErrorCode(std::string_view text) {
  if (text.empty() || text.size() > 64 || text.front() < 'a' || text.front() > 'z') return false;
  int digits = 0;
  for (const char c : text) {
    const bool digit = c >= '0' && c <= '9';
    if (digit) ++digits;
    if (!digit && c != '_' && (c < 'a' || c > 'z')) return false;
  }
  return digits <= 3;
}

bool IsRefusalReason(std::string_view text) {
  if (text.empty() || text.size() > 300) return false;
  for (const char c : text) {
    const bool letter = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
    if (!letter && std::string_view(" _.,:$#*-").find(c) == std::string_view::npos) return false;
  }
  return true;
}

std::string_view ErrorMakerNote(std::string_view code) {
  struct Note {
    std::string_view code;
    std::string_view text;
  };
  static constexpr Note kNotes[] = {
      {"budget_not_approved", "no approved budget is running for this game and this player"},
      {"grant_insufficient_funds", "the player's credits do not cover the call; the budget resumes when they top up"},
      {"grant_price_unreasonable", "the call's maxCredits is above the perCallMaxCredits of the approved budget"},
      {"invalid_schema", "the schema is not one Genex accepts, or was sent without outputFormat json"},
      {"model_not_available", "the modelId is not one of the approved budget's models, or Genex does not serve it"},
      {"provider_budget_insufficient",
       "the call's maxCredits does not cover this model's input reserve; raise maxCredits and the declared perCallMaxCredits"},
      {"provider_token_limit",
       "the answer was cut off at its length limit, and a model that thinks spends answer tokens on thinking; raise maxOutputTokens, or maxCredits when the "
       "result's maxCredits equals the call's (a call's maxCredits can never be above the approved budget's perCallMaxCredits)"},
      {"session_revoked", "the sign-in that approved the budget has ended; the player approves it again"},
  };
  for (const Note& note : kNotes) {
    if (note.code == code) return note.text;
  }
  return {};
}

std::string FailureLogLine(std::string_view call, std::string_view code, int httpStatus, std::string_view reason, std::string_view at, bool rejected) {
  std::string line = "genex models: ";
  line.append(call).append(rejected ? " rejected: " : " failed: ");
  const bool named = IsErrorCode(code);
  line.append(named ? code : std::string_view("a code this plugin cannot read"));
  if (httpStatus > 0) line.append(" (HTTP ").append(std::to_string(httpStatus)).append(")");
  const bool why = IsRefusalReason(reason);
  const bool where = IsRefusalReason(at);
  if (why || where) line.append(":");
  if (why) line.append(" ").append(reason);
  if (where) line.append(" at ").append(at);
  const std::string_view note = named ? ErrorMakerNote(code) : std::string_view();
  if (!note.empty()) line.append(". For the game's maker: ").append(note);
  return line;
}

std::string NativeErrorMessage(const std::string* code) {
  const ModelsSentence* row = code != nullptr ? ModelsSentenceFor(*code) : nullptr;
  return std::string(row != nullptr ? row->text : kModelsGeneralSentence);
}

}  // namespace genex::models
