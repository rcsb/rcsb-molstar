/**
 * Copyright (c) 2020 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Sebastian Bittrich <sebastian.bittrich@rcsb.org>
 */

import * as React from 'react';
import {CollapsableControls, PurePluginUIComponent} from 'molstar/lib/mol-plugin-ui/base';
import {Button, IconButton, ToggleButton} from 'molstar/lib/mol-plugin-ui/controls/common';
import {
    ArrowDownwardSvg,
    ArrowUpwardSvg,
    DeleteOutlinedSvg,
    HelpOutlineSvg,
    Icon, TuneSvg
} from 'molstar/lib/mol-plugin-ui/controls/icons';
import {ActionMenu} from 'molstar/lib/mol-plugin-ui/controls/action-menu';
import {StructureSelectionHistoryEntry} from 'molstar/lib/mol-plugin-state/manager/structure/selection';
import {StructureElement, StructureProperties} from 'molstar/lib/mol-model/structure/structure';
import {ToggleSelectionModeButton} from 'molstar/lib/mol-plugin-ui/structure/selection';
import {OrderedSet} from 'molstar/lib/mol-data/int';

// TODO use prod
// const ADVANCED_SEARCH_URL = 'https://localhost:8080/search?request=';
const ADVANCED_SEARCH_URL = 'https://strucmotif-dev.rcsb.org/search?request=';
const MAX_MOTIF_SIZE = 10;

/**
 * The top-level component that exposes the strucmotif search.
 */
export class StrucmotifSubmitControls extends CollapsableControls {
    protected defaultState() {
        return {
            header: 'Structural Motif Search',
            isCollapsed: false,
            brand: { accent:  'gray' as const, svg: SearchIconSvg }
        };
    }

    renderControls() {
        return <>
            <SubmitControls />
        </>;
    }
}

// TODO nice svg - magnifying glass or something search-y
const _SearchIcon = <svg width='24px' height='24px' viewBox='0 0 24 24'><path d='M8 5v14l11-7z' /></svg>;
export function SearchIconSvg() { return _SearchIcon; }

const location = StructureElement.Location.create(void 0);

type ExchangeState = 'exchanges-0' | 'exchanges-1' | 'exchanges-2' | 'exchanges-3' | 'exchanges-4' | 'exchanges-5' | 'exchanges-6' | 'exchanges-7' | 'exchanges-8' | 'exchanges-9';

/**
 * The inner component of strucmotif search that can be collapsed.
 */
class SubmitControls extends PurePluginUIComponent<{}, { isBusy: boolean, action?: ExchangeState }> {
    state = { isBusy: false, action: void 0 as ExchangeState | undefined }

    componentDidMount() {
        this.subscribe(this.selection.events.additionsHistoryUpdated, () => {
            this.forceUpdate();
        });

        this.subscribe(this.plugin.behaviors.state.isBusy, v => {
            this.setState({ isBusy: v });
        });
    }

    get selection() {
        return this.plugin.managers.structure.selection;
    }

    submitSearch = () => {
        const pdbId: Set<string> = new Set();
        const residueIds: { label_asym_id: string, struct_oper_id?: string, label_seq_id: number }[] = [];

        const loci = this.plugin.managers.structure.selection.additionsHistory;
        let structure;
        for (let i = 0; i < Math.min(MAX_MOTIF_SIZE, loci.length); i++) {
            const l = loci[i];
            structure = l.loci.structure;
            pdbId.add(structure.model.entry);
            // TODO ensure selection references only polymeric entities
            // only first element and only first index will be considered (ignoring multiple residues)
            const e = l.loci.elements[0];
            StructureElement.Location.set(location, structure, e.unit, e.unit.elements[OrderedSet.getAt(e.indices, 0)]);
            residueIds.push({
                label_asym_id: StructureProperties.chain.label_asym_id(location),
                struct_oper_id: '1', // TODO impl
                label_seq_id: StructureProperties.residue.label_seq_id(location)
            });
        }

        if (pdbId.size > 1) {
            console.warn('motifs can only be extracted from a single model');
            return;
        }
        if (residueIds.length > MAX_MOTIF_SIZE) {
            console.warn(`maximum motif size is ${MAX_MOTIF_SIZE} residues`);
            return;
        }

        const query = {
            query: {
                type: 'group',
                logical_operator: 'and',
                nodes: [{
                    type: 'terminal',
                    service: 'strucmotif',
                    parameters: {
                        value: {
                            data: pdbId.values().next().value as string,
                            residue_ids: residueIds
                        },
                        score_cutoff: 5,
                        // TODO add UI to define exchanges
                        exchanges: []
                    },
                    label: 'strucmotif',
                    node_id: 0
                }],
                label: 'query-builder'
            },
            return_type: 'assembly',
            request_options: {
                pager: {
                    start: 0,
                    rows: 100
                },
                scoring_strategy: 'combined',
                sort: [{
                    sort_by: 'score',
                    direction: 'desc'
                }]
            },
            'request_info': {
                'src': 'ui'
            }
        };
        // TODO figure out if Mol* can compose sierra/BioJava operator
        window.open(ADVANCED_SEARCH_URL + encodeURIComponent(JSON.stringify(query)), '_blank');
    }

    get actions(): ActionMenu.Items {
        const history = this.selection.additionsHistory;
        return [
            {
                kind: 'item',
                label: `Submit Search ${history.length < 3 ? ' (3 selections required)' : ''}`,
                value: this.submitSearch,
                disabled: history.length < 3
            },
        ];
    }

    selectAction: ActionMenu.OnSelect = item => {
        if (!item) return;
        (item?.value as any)();
    }

    toggleExchanges = (idx: number) => this.setState({ action: this.state.action === `exchanges-${idx}` ? void 0 : `exchanges-${idx}` as ExchangeState });

    highlight(loci: StructureElement.Loci) {
        this.plugin.managers.interactivity.lociHighlights.highlightOnly({ loci }, false);
    }

    moveHistory(e: StructureSelectionHistoryEntry, direction: 'up' | 'down') {
        this.setState({ action: void 0 });
        this.plugin.managers.structure.selection.modifyHistory(e, direction, MAX_MOTIF_SIZE);
    }

    modifyHistory(e: StructureSelectionHistoryEntry, a: 'remove', idx: number) {
        this.setState({ action: void 0 });
        this.plugin.managers.structure.selection.modifyHistory(e, a);
    }

    focusLoci(loci: StructureElement.Loci) {
        this.plugin.managers.camera.focusLoci(loci);
    }

    historyEntry(e: StructureSelectionHistoryEntry, idx: number) {
        const history = this.plugin.managers.structure.selection.additionsHistory;
        return <div key={e.id}>
            <div className='msp-flex-row'>
                <Button noOverflow title='Click to focus. Hover to highlight.' onClick={() => this.focusLoci(e.loci)} style={{ width: 'auto', textAlign: 'left' }} onMouseEnter={() => this.highlight(e.loci)} onMouseLeave={this.plugin.managers.interactivity.lociHighlights.clearHighlights}>
                    {idx}. <span dangerouslySetInnerHTML={{ __html: e.label }} />
                </Button>
                <ToggleButton icon={TuneSvg} className='msp-form-control' title='Define Exchanges' toggle={() => this.toggleExchanges(idx)} isSelected={this.state.action === `exchanges-${idx}`} disabled={this.state.isBusy} style={{ flex: '0 0 40px', padding: 0 }} />
                {history.length > 1 && <IconButton svg={ArrowUpwardSvg} small={true} className='msp-form-control' onClick={() => this.moveHistory(e, 'up')} flex='20px' title={'Move up'} />}
                {history.length > 1 && <IconButton svg={ArrowDownwardSvg} small={true} className='msp-form-control' onClick={() => this.moveHistory(e, 'down')} flex='20px' title={'Move down'} />}
                <IconButton svg={DeleteOutlinedSvg} small={true} className='msp-form-control' onClick={() => this.modifyHistory(e, 'remove', idx)} flex title={'Remove'} />
            </div>
            { this.state.action === `exchanges-${idx}` && <div className='msp-flex-row'>Options...</div> }
        </div>;
    }

    add() {
        const history = this.plugin.managers.structure.selection.additionsHistory;

        const entries: JSX.Element[] = [];
        for (let i = 0, _i = Math.min(history.length, 10); i < _i; i++) {
            entries.push(this.historyEntry(history[i], i + 1));
        }

        return <>
            <ActionMenu items={this.actions} onSelect={this.selectAction} />
            {entries.length > 0 && <div className='msp-control-offset'>
                {entries}
            </div>}
            {entries.length === 0 && <div className='msp-control-offset msp-help-text'>
                <div className='msp-help-description'><Icon svg={HelpOutlineSvg} inline />Add one or more selections (toggle <ToggleSelectionModeButton inline /> mode)</div>
            </div>}
        </>;
    }

    render() {
        return <>
            {this.add()}
        </>;
    }
}
