import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const bounds = actor => {
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    return {x, y, width, height};
};

export async function runStress({indicator, records, service, settings, assert, wait, screenshot, cycles}) {
    const codex = indicator._providers.get('codex');
    const original = JSON.parse(JSON.stringify(records.codex));
    records.codex.limits.windows = Array.from({length: 32}, (_, index) => ({...original.limits.windows[0],
        id: `synthetic-${index}`, label: `Quota ${index + 1}`}));
    records.codex.history.models = Array.from({length: 48}, (_, index) => ({...original.history.models[0],
        model: `synthetic-model-${index}-${'long-name-'.repeat(8)}`}));
    indicator.render();
    codex.item.menu.open(false);
    codex.activity.activate();
    await wait(350);
    const work = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
    const fit = actor => {
        const box = bounds(actor);
        return Object.values(box).every(Number.isFinite) && box.x >= work.x - 1 && box.y >= work.y - 1 &&
            box.x + box.width <= work.x + work.width + 1 && box.y + box.height <= work.y + work.height + 1;
    };
    assert(fit(indicator.menu.actor), `Long-content popup exceeds work area: ${JSON.stringify(bounds(indicator.menu.actor))}`);
    assert(fit(indicator._terminalButton), 'Long-content popup hides the footer');
    const scroll = codex.item.menu.actor;
    assert(scroll instanceof St.ScrollView, 'Provider must provide one native scroll area');
    assert(codex.details.box.get_children().length >= 55, 'Long activity lists lose records');
    const lastRow = codex.item.menu.box.get_last_child();
    lastRow.grab_key_focus();
    scroll.vadjustment.value = scroll.vadjustment.upper;
    await wait();
    assert(fit(indicator._terminalButton), 'Scrolling moves footer offscreen');
    await screenshot('long-content');
    const longContent = bounds(scroll);
    records.codex = original;
    indicator.render();
    for (let iteration = 0; iteration < cycles; iteration++) {
        const id = iteration % 2 ? 'codex' : 'claude';
        indicator._providers.get(id).item.menu.open(false);
        const state = indicator._providers.get(id);
        state.activity.activate();
        indicator.render();
        state.activity.activate();
        await wait(5);
    }
    indicator.menu.close(0);
    const states = [...indicator._providers.values()];
    const items = states.map(state => state.item);
    for (let iteration = 0; iteration < 100; iteration++)
        indicator.render();
    indicator.menu.open(0);
    await wait();
    assert(items.every((item, index) => item === [...indicator._providers.values()][index].item),
        'Closed-popup refreshes rebuild menu actors');
    records.claude = {...records.claude, limits: {...records.claude.limits, status: 'stale', message: 'Saved account limits'}};
    indicator.render();
    service.enabledProviders = [];
    indicator.render();
    assert(indicator._providers.size === 0 && !indicator._terminalButton.reactive, 'Empty-provider state permits terminal launch');
    service.enabledProviders = ['claude', 'codex'];
    settings.set_string('default-provider', 'unknown');
    indicator.render();
    assert([...indicator._providers.keys()].join(',') === 'claude,codex', 'Provider ordering failed');
    assert(indicator._selectedProvider === 'claude', 'Unknown selected provider does not fall back');
    await wait();
    return {renderCycles: cycles, longContent, emptyAndUnknownProviders: true};
}
