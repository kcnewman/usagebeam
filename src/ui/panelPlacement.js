import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export function placeIndicator(indicator, position) {
    const container = indicator.container;
    const target = position === 'left' ? Main.panel._leftBox : Main.panel._rightBox;
    container.get_parent()?.remove_child(container);
    target.insert_child_at_index(container, position === 'left' ? target.get_n_children() : 0);
}
