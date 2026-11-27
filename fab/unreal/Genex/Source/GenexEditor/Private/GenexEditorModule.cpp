// Copyright Genex. All Rights Reserved.

#include "GenexChatLibrary.h"

#include "Brushes/SlateImageBrush.h"
#include "Input/Reply.h"
#include "Interfaces/IPluginManager.h"
#include "Modules/ModuleManager.h"
#include "Styling/AppStyle.h"
#include "Styling/SlateColor.h"
#include "Styling/SlateStyle.h"
#include "Styling/SlateStyleRegistry.h"
#include "ToolMenus.h"
#include "Widgets/Images/SImage.h"
#include "Widgets/Input/SButton.h"

#define LOCTEXT_NAMESPACE "GenexEditor"

namespace
{
	const FName GenexStyleName(TEXT("GenexStyle"));
	const FName GenexLogoName(TEXT("Genex.Logo"));
	/** The same toolbar, section and entry Genex's own editor helper uses, so there is never a second button. */
	const FName GenexToolBar(TEXT("LevelEditor.LevelEditorToolBar.PlayToolBar"));
	const FName GenexSection(TEXT("Genex"));
	const FName GenexEntry(TEXT("Genex.OpenChat"));
	/** The word GENEX as the toolbar shows it: the logo's own proportions at the height of the toolbar's text. */
	const FVector2D GenexLogoSize(76.0, 12.0);
	const FMargin GenexButtonPadding(8.0, 6.0);
}

/** Puts the Genex button, the word GENEX as the logo draws it, on the level editor's toolbar. */
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
		// A toolbar is built once per window that shows it, and a widget has one parent: each build gets its own button.
		Section.AddDynamicEntry(GenexEntry, FNewToolMenuSectionDelegate::CreateRaw(this, &FGenexEditorModule::AddButtonTo));
	}

	void AddButtonTo(FToolMenuSection& Section)
	{
		Section.AddEntry(FToolMenuEntry::InitWidget(GenexEntry, MakeButton(), FText::GetEmpty(), true, false));
	}

	/** The button itself: a toolbar icon is square, and the word is wide, so it is a plain button around the logo. */
	TSharedRef<SWidget> MakeButton() const
	{
		const FSlateBrush* Logo = Style.IsValid() ? Style->GetBrush(GenexLogoName) : FAppStyle::GetNoBrush();
		return SNew(SButton)
			.ButtonStyle(FAppStyle::Get(), "SimpleButton")
			.ContentPadding(GenexButtonPadding)
			.VAlign(VAlign_Center)
			.ToolTipText(LOCTEXT("GenexButtonToolTip", "Open this project's chat in Genex"))
			.OnClicked_Lambda([]()
			{
				UGenexChatLibrary::OpenChat();
				return FReply::Handled();
			})
			[
				SNew(SImage)
				.Image(Logo)
				.ColorAndOpacity(FSlateColor::UseForeground())
			];
	}

	TSharedPtr<FSlateStyleSet> Style;
};

#undef LOCTEXT_NAMESPACE

IMPLEMENT_MODULE(FGenexEditorModule, GenexEditor)
