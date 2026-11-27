// Copyright Genex. All Rights Reserved.

#include "GenexChatLibrary.h"

#include "Brushes/SlateImageBrush.h"
#include "Framework/Commands/UIAction.h"
#include "Interfaces/IPluginManager.h"
#include "Modules/ModuleManager.h"
#include "Styling/SlateStyle.h"
#include "Styling/SlateStyleRegistry.h"
#include "Textures/SlateIcon.h"
#include "ToolMenus.h"

#define LOCTEXT_NAMESPACE "GenexEditor"

namespace
{
	const FName GenexStyleName(TEXT("GenexStyle"));
	const FName GenexLogoName(TEXT("Genex.Logo"));
	/** The same toolbar, section and entry Genex's own editor helper uses, so there is never a second button. */
	const FName GenexToolBar(TEXT("LevelEditor.LevelEditorToolBar.PlayToolBar"));
	const FName GenexSection(TEXT("Genex"));
	const FName GenexEntry(TEXT("Genex.OpenChat"));
	const FVector2D GenexLogoSize(20.0, 20.0);
}

/** Puts the Genex button, with the Genex logo, on the level editor's toolbar. */
class FGenexEditorModule : public IModuleInterface
{
public:
	virtual void StartupModule() override
	{
		RegisterStyle();
		UToolMenus::RegisterStartupCallback(FSimpleMulticastDelegate::FDelegate::CreateRaw(this, &FGenexEditorModule::AddButton));
	}

	virtual void ShutdownModule() override
	{
		UToolMenus::UnRegisterStartupCallback(this);
		UToolMenus::UnregisterOwner(this);
		if (Style.IsValid())
		{
			FSlateStyleRegistry::UnRegisterSlateStyle(*Style);
			Style.Reset();
		}
	}

private:
	void RegisterStyle()
	{
		const TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("Genex"));
		if (!Plugin.IsValid())
		{
			return;
		}
		Style = MakeShared<FSlateStyleSet>(GenexStyleName);
		Style->SetContentRoot(Plugin->GetBaseDir() / TEXT("Resources"));
		Style->Set(GenexLogoName, new FSlateVectorImageBrush(Style->RootToContentDir(TEXT("GenexLogo"), TEXT(".svg")), GenexLogoSize));
		FSlateStyleRegistry::RegisterSlateStyle(*Style);
	}

	void AddButton()
	{
		FToolMenuOwnerScoped Owner(this);
		UToolMenu* ToolBar = UToolMenus::Get()->ExtendMenu(GenexToolBar);
		FToolMenuSection& Section = ToolBar->FindOrAddSection(GenexSection);
		Section.AddEntry(FToolMenuEntry::InitToolBarButton(
			GenexEntry,
			FUIAction(FExecuteAction::CreateStatic(&UGenexChatLibrary::OpenChat)),
			LOCTEXT("GenexButtonLabel", "Genex"),
			LOCTEXT("GenexButtonToolTip", "Open this project's chat in Genex"),
			FSlateIcon(GenexStyleName, GenexLogoName)));
	}

	TSharedPtr<FSlateStyleSet> Style;
};

#undef LOCTEXT_NAMESPACE

IMPLEMENT_MODULE(FGenexEditorModule, GenexEditor)
