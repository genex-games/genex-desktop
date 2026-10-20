//! Presets (G6 gameplay UI, UIS-7, D19): a named set of values for one tab's options. Choosing a
//! preset clears that tab's per-option changes; a change after it is kept as a delta over the
//! preset, so `genex-settings.json` holds the preset's name plus only what the person moved.

use crate::settings::schema::{PRESETS_PER_TAB_MAX, SettingValue, SettingsErrorCode, SettingsIssue, SettingsSchema, SettingsTab};

/// One preset of a tab.
#[derive(Clone, Debug, PartialEq)]
pub struct Preset {
    tab: SettingsTab,
    name: String,
    values: Vec<(String, SettingValue)>,
}

impl Preset {
    /// A preset of `tab` named `name` (a text key) setting `values`.
    pub fn new(tab: SettingsTab, name: &str, values: &[(&str, SettingValue)]) -> Preset {
        Preset { tab, name: name.to_owned(), values: values.iter().map(|(key, value)| ((*key).to_owned(), *value)).collect() }
    }

    /// Its tab.
    pub fn tab(&self) -> SettingsTab {
        self.tab
    }

    /// Its name (a text key, and its spelling in `genex-settings.json`).
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The value it sets for `key`, if it sets one.
    pub fn value(&self, key: &str) -> Option<SettingValue> {
        self.values.iter().find(|(own, _)| own == key).map(|(_, value)| *value)
    }

    /// The values it sets, in declaration order.
    pub fn values(&self) -> impl Iterator<Item = (&str, SettingValue)> + '_ {
        self.values.iter().map(|(key, value)| (key.as_str(), *value))
    }

    /// Check the preset against the schema and the presets declared before it: a legal name not
    /// repeated on its tab, at most [`PRESETS_PER_TAB_MAX`] per tab, and values for its own tab's
    /// options that fit them exactly (on their step).
    pub(crate) fn validate(&self, schema: &SettingsSchema, earlier: &[Preset]) -> Result<(), SettingsIssue> {
        let subject = format!("{}:{}", self.tab.wire(), self.name);
        let refused = |detail: String| SettingsIssue::new(SettingsErrorCode::Invalid, &subject, detail);
        if !crate::settings::schema::key_ok(&self.name) {
            return Err(refused(format!("preset name {:?} is not a legal key", self.name)));
        }
        let same_tab = earlier.iter().filter(|other| other.tab == self.tab);
        if same_tab.clone().any(|other| other.name == self.name) {
            return Err(refused(format!("preset {subject} is declared twice")));
        }
        if same_tab.count() >= PRESETS_PER_TAB_MAX {
            return Err(refused(format!("the {} tab has more than {PRESETS_PER_TAB_MAX} presets", self.tab.wire())));
        }
        for (at, (key, value)) in self.values.iter().enumerate() {
            let fits = schema.tab_of(key) == Some(self.tab)
                && schema.def(key).is_some_and(|def| def.check(*value).is_ok_and(|checked| checked == *value));
            if !fits || self.values[..at].iter().any(|(earlier_key, _)| earlier_key == key) {
                return Err(refused(format!("preset {subject} sets {key}, which is not one of its tab's options, or to a value that does not fit")));
            }
        }
        Ok(())
    }
}
