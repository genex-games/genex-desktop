namespace Genex.Unity
{
    /// <summary>Owns a test run before its deferred Editor callback can start.</summary>
    internal sealed class TestJobReservation
    {
        public string Owner { get; private set; }
        public bool ObservedRunActive { get; set; }

        public void AssertAvailable()
        {
            if (Owner != null || ObservedRunActive)
                throw new BridgeException("busy", "A Unity test run is already active or queued");
        }
        public void Reserve(string id)
        {
            AssertAvailable();
            Owner = id;
        }
        public bool Release(string id)
        {
            if (Owner == null || id != Owner) return false;
            Owner = null;
            return true;
        }
    }
}
