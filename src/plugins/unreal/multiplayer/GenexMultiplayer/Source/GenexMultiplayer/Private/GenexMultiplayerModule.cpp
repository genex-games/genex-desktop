#include "GenexMultiplayerModule.h"

#include "GenexCore/GenexClock.h"
#include "GenexCore/GenexIdentity.h"
#include "GenexCore/GenexLog.h"
#include "GenexCore/GenexPhysicsNative.h"
#include "GenexCore/GenexPump.h"
#include "HAL/PlatformProcess.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/CoreDelegates.h"
#include "Misc/Paths.h"
#include "Misc/ScopeLock.h"
#include "Modules/ModuleManager.h"

DEFINE_LOG_CATEGORY(LogGenex);

namespace GenexModuleDetail
{
/** The launcher's ticket, held from startup until a sign-in takes it (never logged). */
TOptional<FString> LaunchTicket;
/** Whether the Colyseus core can be called (FGenexMultiplayerModule::IsAvailable). */
bool bAvailable = true;
/** The physics core, bound on first use (FGenexMultiplayerModule::PhysicsCore), and whether that was tried. */
std::shared_ptr<genex::physics::PredictCore> PhysicsCore;
bool bPhysicsTried = false;
FCriticalSection PhysicsLock;

/** Loads and binds the physics core's C ABI, staged beside the plugin's binaries
 *  (GenexPhysicsNative.Build.cs): resolved by name, never linked, so a missing or refused library only
 *  turns physics prediction off (the session reports `unavailable`). The library is never unloaded:
 *  a world may outlive any scope. The session runs the self-test scene itself (`self_test`). */
std::shared_ptr<genex::physics::PredictCore> LoadPhysicsCore()
{
#if defined(GENEX_PHYSICS_NATIVE_LIBRARY)
	TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("GenexMultiplayer"));
	if (!Plugin) return nullptr;
	const FString Library = FPaths::Combine(Plugin->GetBaseDir(), TEXT(GENEX_PHYSICS_NATIVE_LIBRARY));
	void* Handle = FPlatformProcess::GetDllHandle(*Library);
	if (!Handle)
	{
		UE_LOG(LogGenex, Warning, TEXT("Genex: no physics core at %s; physics bodies are drawn from the server's states."), *Library);
		return nullptr;
	}
	std::string Error;
	std::shared_ptr<genex::physics::NativeCore> Bound = genex::physics::NativeCore::Bind(
		[Handle](const char* Name) { return FPlatformProcess::GetDllExport(Handle, UTF8_TO_TCHAR(Name)); }, &Error);
	if (!Bound)
	{
		UE_LOG(LogGenex, Warning, TEXT("Genex: the physics core was refused (%s); physics bodies are drawn from the server's states."), UTF8_TO_TCHAR(Error.c_str()));
		return nullptr;
	}
	return Bound;
#else
	return nullptr;
#endif
}
}

std::shared_ptr<genex::physics::PredictCore> FGenexMultiplayerModule::PhysicsCore()
{
	// PROTOCOL.md §17.11: the core loads only once a room sends keyframes; never at module startup.
	FScopeLock Lock(&GenexModuleDetail::PhysicsLock);
	if (!GenexModuleDetail::bPhysicsTried)
	{
		GenexModuleDetail::bPhysicsTried = true;
		GenexModuleDetail::PhysicsCore = GenexModuleDetail::LoadPhysicsCore();
	}
	return GenexModuleDetail::PhysicsCore;
}

bool FGenexMultiplayerModule::IsAvailable()
{
	return GenexModuleDetail::bAvailable;
}

#if WITH_DEV_AUTOMATION_TESTS
void FGenexMultiplayerModule::SetLaunchTicketForTests(TOptional<FString> Ticket)
{
	GenexModuleDetail::LaunchTicket = MoveTemp(Ticket);
}

void FGenexMultiplayerModule::SetAvailableForTests(bool bAvailable)
{
	GenexModuleDetail::bAvailable = bAvailable;
}
#endif

TOptional<FString> FGenexMultiplayerModule::TakeLaunchTicket()
{
	TOptional<FString> Ticket = MoveTemp(GenexModuleDetail::LaunchTicket);
	GenexModuleDetail::LaunchTicket.Reset();
	return Ticket;
}

void FGenexMultiplayerModule::StartupModule()
{
	// First thing (§6b): the ticket lives 60 s and must not reach a child process.
	if (std::optional<std::string> Ticket = genex::TakeLaunchTicket())
	{
		GenexModuleDetail::LaunchTicket = FString(UTF8_TO_TCHAR(Ticket->c_str()));
	}
#if defined(GENEX_COLYSEUS_DLL) && GENEX_COLYSEUS_DLL
	// colyseus.dll is delay-loaded (ColyseusNative.Build.cs): load it from the plugin's own Binaries
	// before anything calls into it, so the game's executable folder never has to hold it.
	if (TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("GenexMultiplayer")))
	{
		const FString Dll = FPaths::Combine(Plugin->GetBaseDir(), TEXT("Binaries/ThirdParty/ColyseusNative/Win64/colyseus.dll"));
		ColyseusDll = FPlatformProcess::GetDllHandle(*Dll);
	}
	if (!ColyseusDll)
	{
		// The core is delay-loaded: the first colyseus_* call would retry the default search path, fail
		// the same way and raise the loader's exception. So nothing calls into it from here on: no pump,
		// and the subsystems refuse every join by name (IsAvailable).
		GenexModuleDetail::bAvailable = false;
		UE_LOG(LogGenex, Error, TEXT("Genex: could not load colyseus.dll from the GenexMultiplayer plugin; multiplayer is unavailable."));
		return;
	}
#endif
	genex::SetLogSink([](genex::LogLevel Level, const std::string& Message) {
		const FString Text = UTF8_TO_TCHAR(Message.c_str());
		switch (Level)
		{
		case genex::LogLevel::Error: UE_LOG(LogGenex, Error, TEXT("%s"), *Text); break;
		case genex::LogLevel::Warning: UE_LOG(LogGenex, Warning, TEXT("%s"), *Text); break;
		case genex::LogLevel::Info: UE_LOG(LogGenex, Log, TEXT("%s"), *Text); break;
		default: UE_LOG(LogGenex, Verbose, TEXT("%s"), *Text); break;
		}
	});
	genex::Pump::EnsurePolled();
	BeginFrameHandle = FCoreDelegates::OnBeginFrame.AddRaw(this, &FGenexMultiplayerModule::OnBeginFrame);
	TickerHandle = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateRaw(this, &FGenexMultiplayerModule::OnTicker));
}

void FGenexMultiplayerModule::ShutdownModule()
{
	if (BeginFrameHandle.IsValid()) FCoreDelegates::OnBeginFrame.Remove(BeginFrameHandle);
	if (TickerHandle.IsValid()) FTSTicker::GetCoreTicker().RemoveTicker(TickerHandle);
	genex::SetLogSink(nullptr);
	GenexModuleDetail::LaunchTicket.Reset();
	// Worlds hold the core: sessions are gone by now, and the library stays loaded for any left.
	{
		FScopeLock Lock(&GenexModuleDetail::PhysicsLock);
		GenexModuleDetail::PhysicsCore.reset();
	}
	if (ColyseusDll)
	{
		FPlatformProcess::FreeDllHandle(ColyseusDll);
		ColyseusDll = nullptr;
	}
}

void FGenexMultiplayerModule::OnBeginFrame()
{
	++BeginFrames;
	PumpFrame();
}

bool FGenexMultiplayerModule::OnTicker(float)
{
	// Only when no frame began since the last ticker (OnBeginFrame not firing): never twice a frame.
	if (BeginFrames == BeginFramesAtLastTicker) PumpFrame();
	BeginFramesAtLastTicker = BeginFrames;
	return true;
}

void FGenexMultiplayerModule::PumpFrame()
{
	++Pumped;
	genex::Pump::Frame(genex::Clock::NowMs(), Pumped);
}

IMPLEMENT_MODULE(FGenexMultiplayerModule, GenexMultiplayer)
