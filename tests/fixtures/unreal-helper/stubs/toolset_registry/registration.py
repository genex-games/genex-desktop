"""A stand-in for Epic's Registration: remembers the toolsets each registration was given."""

# Every registered list of toolset classes, in order, so a test can read what the helper registered.
registered: list[tuple] = []


class Registration:
    def __init__(self, toolset_classes) -> None:
        self.toolset_classes = tuple(toolset_classes)

    def register(self) -> bool:
        registered.append(self.toolset_classes)
        return True
