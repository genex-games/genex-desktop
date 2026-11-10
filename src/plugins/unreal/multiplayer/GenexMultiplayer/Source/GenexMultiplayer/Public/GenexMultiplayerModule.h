// The GenexMultiplayer runtime module. It owns the ONE pump of the Colyseus core for the process
// (colyseus_poll is process-wide): genex::Pump::Frame runs once per engine frame from
// FCoreDelegates::OnBeginFrame, which fires before every world ticks (the game's, the editor's and
// each PIE client's; SPIKE.md "Where to pump the core"), so Blueprint and C++ game code see the
// state that arrived this frame and the inputs staged last frame leave now. An FTSTicker pumps
// only in a stretch where no frame begins (none has been seen in this build; a safety net).
#pragma once

#include "Modules/ModuleInterface.h"
#include "Containers/Ticker.h"

#include <memory>

namespace genex::physics
{
class PredictCore;
}

DECLARE_LOG_CATEGORY_EXTERN(LogGenex, Log, All);

class GENEXMULTIPLAYER_API FGenexMultiplayerModule : public IModuleInterface
{
public:
	virtual void StartupModule() override;
	virtual void ShutdownModule() override;

	/** The launcher's one-use GENEX_EMBED_TICKET, read (and removed from the environment) once at
	 *  module startup; the first caller takes it, every later call answers unset. */
	static TOptional<FString> TakeLaunchTicket();

	/** Whether the Colyseus core loaded. False only on Win64 when colyseus.dll could not be loaded
	 *  from the plugin's Binaries: nothing calls into it then (the core is delay-loaded, so a call
	 *  would raise the loader's exception), and every join is refused by name. */
	static bool IsAvailable();

	/** The physics core (ThirdParty/GenexPhysicsNative) every authority session predicts a predicting
	 *  physics room with (PROTOCOL.md §17.11), loaded and bound the first time it is asked for (a session
	 *  asks when a room first sends keyframes, never at module startup); null when it did not load or
	 *  bind: bodies are then drawn from the server's states. Any thread. */
	static std::shared_ptr<genex::physics::PredictCore> PhysicsCore();

#if WITH_DEV_AUTOMATION_TESTS
	/** Tests: hand the module a launcher ticket as if GENEX_EMBED_TICKET had held it (unset clears). */
	static void SetLaunchTicketForTests(TOptional<FString> Ticket);
	/** Tests: pretend the core did (not) load. */
	static void SetAvailableForTests(bool bAvailable);
#endif

	/** Frames pumped so far (tests). */
	uint64 PumpedFrames() const { return Pumped; }

private:
	void OnBeginFrame();
	bool OnTicker(float DeltaSeconds);
	void PumpFrame();

	FDelegateHandle BeginFrameHandle;
	FTSTicker::FDelegateHandle TickerHandle;
	uint64 Pumped = 0;
	uint64 BeginFrames = 0;
	uint64 BeginFramesAtLastTicker = 0;
	void* ColyseusDll = nullptr;
};
