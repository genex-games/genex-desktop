// Copyright Genex. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "GenexChatLibrary.generated.h"

/**
 * What the Genex button does, callable from editor scripts too. Genex's own editor helper looks
 * for this class to know the button is already on the toolbar.
 */
UCLASS()
class GENEXEDITOR_API UGenexChatLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	/** The link that names this project's folder: genex://editor/ and the folder's whole path as unpadded base64url. */
	UFUNCTION(BlueprintCallable, Category = "Genex")
	static FString ProjectLink();

	/** Whether a program on this computer answers genex:// links, which is how the Genex app is found. */
	UFUNCTION(BlueprintCallable, Category = "Genex")
	static bool IsGenexInstalled();

	/** Open this project's chat in Genex, or the page to get Genex when it is not on this computer. */
	UFUNCTION(BlueprintCallable, Category = "Genex")
	static void OpenChat();
};
