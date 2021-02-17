/**
 * Copyright (c) 2019-2020 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { BehaviorSubject } from 'rxjs';
import { DefaultPluginSpec } from 'molstar/lib/mol-plugin';
import { Plugin } from 'molstar/lib/mol-plugin-ui/plugin';
import { PluginContext } from 'molstar/lib/mol-plugin/context';
import { PluginCommands } from 'molstar/lib/mol-plugin/commands';
import { ViewerState as ViewerState, CollapsedState, ModelUrlProvider } from './types';
import { PluginSpec } from 'molstar/lib/mol-plugin/spec';

import { ColorNames } from 'molstar/lib/mol-util/color/names';
import * as React from 'react';
import * as ReactDOM from 'react-dom';

import { ModelLoader } from './helpers/model';
import { PresetProps } from './helpers/preset';
import { ControlsWrapper } from './ui/controls';
import { PluginConfig } from 'molstar/lib/mol-plugin/config';
import { RCSBAssemblySymmetry } from 'molstar/lib/extensions/rcsb/assembly-symmetry/behavior';
import { RCSBValidationReport } from 'molstar/lib/extensions/rcsb/validation-report/behavior';
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra';
import { PluginState } from 'molstar/lib/mol-plugin/state';
import { BuiltInTrajectoryFormat } from 'molstar/lib/mol-plugin-state/formats/trajectory';
import { ObjectKeys } from 'molstar/lib/mol-util/type-helpers';
import { PluginLayoutControlsDisplay } from 'molstar/lib/mol-plugin/layout';
import {Structure} from 'molstar/lib/mol-model/structure/structure';
import {Script} from 'molstar/lib/mol-script/script';
import {MolScriptBuilder} from 'molstar/lib/mol-script/language/builder';
import {SetUtils} from 'molstar/lib/mol-util/set';
import {Loci} from 'molstar/lib/mol-model/loci';
import {StructureSelection} from 'molstar/lib/mol-model/structure/query';
import {StructureRef} from 'molstar/lib/mol-plugin-state/manager/structure/hierarchy-state';
import {StructureSelectionQuery} from 'molstar/lib/mol-plugin-state/helpers/structure-selection-query';
import {StructureRepresentationRegistry} from 'molstar/lib/mol-repr/structure/registry';

/** package version, filled in at bundle build time */
declare const __RCSB_MOLSTAR_VERSION__: string;
export const RCSB_MOLSTAR_VERSION = typeof __RCSB_MOLSTAR_VERSION__ != 'undefined' ? __RCSB_MOLSTAR_VERSION__ : 'none';

/** unix time stamp, to be filled in at bundle build time */
declare const __BUILD_TIMESTAMP__: number;
export const BUILD_TIMESTAMP = typeof __BUILD_TIMESTAMP__ != 'undefined' ? __BUILD_TIMESTAMP__ : 'none';
export const BUILD_DATE = new Date(BUILD_TIMESTAMP);

const Extensions = {
    'rcsb-assembly-symmetry': PluginSpec.Behavior(RCSBAssemblySymmetry),
    'rcsb-validation-report': PluginSpec.Behavior(RCSBValidationReport)
};

const DefaultViewerProps = {
    showImportControls: false,
    showSessionControls: false,
    modelUrlProviders: [
        (pdbId: string) => ({
            url: `//models.rcsb.org/${pdbId.toLowerCase()}.bcif`,
            format: 'mmcif',
            isBinary: true
        }),
        (pdbId: string) => ({
            url: `//files.rcsb.org/download/${pdbId.toLowerCase()}.cif`,
            format: 'mmcif',
            isBinary: false
        })
    ] as ModelUrlProvider[],

    extensions: ObjectKeys(Extensions),
    layoutIsExpanded: false,
    layoutShowControls: true,
    layoutControlsDisplay: 'reactive' as PluginLayoutControlsDisplay,
    layoutShowSequence: true,
    layoutShowLog: false,

    viewportShowExpand: true,
    viewportShowSelectionMode: true,
    volumeStreamingServer: '//maps.rcsb.org/',

    backgroundColor: ColorNames.white,
    showWelcomeToast: true
};
export type ViewerProps = typeof DefaultViewerProps

export class Viewer {
    private readonly plugin: PluginContext;
    private readonly modelUrlProviders: ModelUrlProvider[];

    private get customState() {
        return this.plugin.customState as ViewerState;
    }

    constructor(target: string | HTMLElement, props: Partial<ViewerProps> = {}) {
        target = typeof target === 'string' ? document.getElementById(target)! : target;

        const o = { ...DefaultViewerProps, ...props };

        const spec: PluginSpec = {
            actions: [...DefaultPluginSpec.actions],
            behaviors: [
                ...DefaultPluginSpec.behaviors,
                ...o.extensions.map(e => Extensions[e]),
            ],
            animations: [...DefaultPluginSpec.animations || []],
            customParamEditors: DefaultPluginSpec.customParamEditors,
            layout: {
                initial: {
                    isExpanded: o.layoutIsExpanded,
                    showControls: o.layoutShowControls,
                    controlsDisplay: o.layoutControlsDisplay,
                },
                controls: {
                    ...DefaultPluginSpec.layout && DefaultPluginSpec.layout.controls,
                    top: o.layoutShowSequence ? undefined : 'none',
                    bottom: o.layoutShowLog ? undefined : 'none',
                    left: 'none',
                    right: ControlsWrapper,
                }
            },
            components: {
                ...DefaultPluginSpec.components,
                remoteState: 'none',
            },
            config: [
                [PluginConfig.Viewport.ShowExpand, o.viewportShowExpand],
                [PluginConfig.Viewport.ShowSelectionMode, o.viewportShowSelectionMode],
                [PluginConfig.Viewport.ShowAnimation, false],
                [PluginConfig.VolumeStreaming.DefaultServer, o.volumeStreamingServer],
                [PluginConfig.Download.DefaultPdbProvider, 'rcsb'],
                [PluginConfig.Download.DefaultEmdbProvider, 'rcsb']
            ]
        };

        this.plugin = new PluginContext(spec);
        this.modelUrlProviders = o.modelUrlProviders;

        (this.plugin.customState as ViewerState) = {
            showImportControls: o.showImportControls,
            showSessionControls: o.showSessionControls,
            modelLoader: new ModelLoader(this.plugin),
            collapsed: new BehaviorSubject<CollapsedState>({
                selection: true,
                strucmotifSubmit: true,
                measurements: true,
                superposition: true,
                component: false,
                volume: true,
                custom: true,
            }),
        };

        this.plugin.init();
        ReactDOM.render(React.createElement(Plugin, { plugin: this.plugin }), target);
        // TODO Check why this.plugin.canvas3d can be null
        // this.plugin.canvas3d can be null. The value is not assigned until React Plugin component is mounted
        // Next wait Promise guarantees that its value is defined
        const wait: Promise<void> = new Promise<void>((resolve, reject)=>{
            const recursive: () => void = () => {
                if(this.plugin.canvas3d != null){
                    resolve();
                }else{
                    setTimeout(()=>{
                        recursive();
                    }, 100);
                }
            };
            recursive();
        });
        wait.then(result=>{
            const renderer = this.plugin.canvas3d!.props.renderer;
            PluginCommands.Canvas3D.SetSettings(this.plugin, { settings: { renderer: { ...renderer, backgroundColor: o.backgroundColor } } });
        });
        if (o.showWelcomeToast) {
            PluginCommands.Toast.Show(this.plugin, {
                title: 'Welcome',
                message: `RCSB PDB Mol* Viewer ${RCSB_MOLSTAR_VERSION} [${BUILD_DATE.toLocaleString()}]`,
                key: 'toast-welcome',
                timeoutMs: 5000
            });
        }
    }

    //

    resetCamera(durationMs?: number) {
        this.plugin.managers.camera.reset(undefined, durationMs);
    }

    clear() {
        const state = this.plugin.state.data;
        return PluginCommands.State.RemoveObject(this.plugin, { state, ref: state.tree.root.ref });
    }

    async loadPdbId(pdbId: string, props?: PresetProps, matrix?: Mat4) {
        for (const provider of this.modelUrlProviders) {
            try {
                const p = provider(pdbId);
                await this.customState.modelLoader.load({ fileOrUrl: p.url, format: p.format, isBinary: p.isBinary }, props, matrix);
                break;
            } catch (e) {
                console.warn(`loading '${pdbId}' failed with '${e}', trying next model-loader-provider`);
            }
        }
    }

    async loadPdbIds(args: { pdbId: string, props?: PresetProps, matrix?: Mat4 }[]) {
        for (const { pdbId, props, matrix } of args) {
            await this.loadPdbId(pdbId, props, matrix);
        }
        this.resetCamera(0);
    }

    loadStructureFromUrl(url: string, format: BuiltInTrajectoryFormat, isBinary: boolean, props?: PresetProps, matrix?: Mat4) {
        return this.customState.modelLoader.load({ fileOrUrl: url, format, isBinary }, props, matrix);
    }

    loadSnapshotFromUrl(url: string, type: PluginState.SnapshotType) {
        return PluginCommands.State.Snapshots.OpenUrl(this.plugin, { url, type });
    }

    async loadStructureFromData(data: string | number[], format: BuiltInTrajectoryFormat, isBinary: boolean, props?: PresetProps & { dataLabel?: string }, matrix?: Mat4) {
        return this.customState.modelLoader.parse({ data, format, isBinary }, props, matrix);
    }

    pluginCall(f: (plugin: PluginContext) => void){
        f(this.plugin);
    }

    public getPlugin(): PluginContext {
        return this.plugin;
    }

    public setFocus(modelId: string, asymId: string, begin: number, end: number): void;
    public setFocus(...args: any[]): void{
        if(args.length === 4)
            this.setFocusFromRange(args[0], args[1], args[2], args[3]);
    }
    private setFocusFromRange(modelId: string, asymId: string, begin: number, end: number): void{
        const loci: Loci | undefined = getLociFromRange(this.plugin, modelId, asymId, begin, end);
        if(loci == null)
            return;
        this.plugin.managers.structure.focus.setFromLoci(loci);
    }
    public clearFocus(): void {
        this.plugin.managers.structure.focus.clear();
    }

    public select(selection: Array<{modelId: string; asymId: string; position: number;}>, mode: 'select'|'hover', modifier: 'add'|'set'): void;
    public select(modelId: string, asymId: string, position: number, mode: 'select'|'hover', modifier: 'add'|'set'): void;
    public select(modelId: string, asymId: string, begin: number, end: number, mode: 'select'|'hover', modifier: 'add'|'set'): void;
    public select(...args: any[]){
        if(args.length === 3){
            if(args[2] === 'set')
                this.clearSelection('select');
            (args[0] as Array<{modelId: string; asymId: string; position: number;}>).forEach(r=>{
                this.selectSegment(r.modelId, r.asymId, r.position, r.position, args[1], 'add');
            });
        }else if(args.length === 5){
            this.selectSegment(args[0], args[1], args[2], args[2], args[3], args[4]);
        }else if(args.length === 6){
            this.selectSegment(args[0], args[1], args[2], args[3], args[4], args[5]);
        }
    }
    private selectSegment(modelId: string, asymId: string, begin: number, end: number, mode: 'select'|'hover', modifier: 'add'|'set'): void {
        const loci: Loci | undefined = getLociFromRange(this.plugin, modelId, asymId, begin, end);
        if(loci == null)
            return;
        if(mode == null || mode === 'select') {
            this.plugin.managers.structure.selection.fromLoci(modifier, loci);
        }else if(mode === 'hover') {
            this.plugin.managers.interactivity.lociHighlights.highlight({loci});
        }
    }
    public clearSelection(mode: 'select'|'hover', options?: {modelId: string; labelAsymId: string;}): void {
        if(mode == null || mode === 'select') {
            if(options == null){
                this.plugin.managers.interactivity.lociSelects.deselectAll();
            }else{
                const data: Structure | undefined = getStructureWithModelId(this.plugin.managers.structure.hierarchy.current.structures, options.modelId);
                if (data == null) return;
                const sel: StructureSelection = Script.getStructureSelection(Q => Q.struct.generator.atomGroups({
                    'chain-test': Q.core.rel.eq([options.labelAsymId, MolScriptBuilder.ammp('label_asym_id')])
                }), data);
                const loci: Loci = StructureSelection.toLociWithSourceUnits(sel);
                this.plugin.managers.interactivity.lociSelects.deselect({loci});
            }
        }else if(mode === 'hover') {
            this.plugin.managers.interactivity.lociHighlights.clearHighlights();
        }
    }

    public async createComponent(componentLabel: string, modelId: string, asymId: string, representationType: StructureRepresentationRegistry.BuiltIn): Promise<void>;
    public async createComponent(componentLabel: string, modelId: string, residues: Array<{asymId: string, position: number}>, representationType: StructureRepresentationRegistry.BuiltIn): Promise<void>;
    public async createComponent(componentLabel: string, modelId: string, asymId: string, begin: number, end: number, representationType: StructureRepresentationRegistry.BuiltIn): Promise<void>;
    public async createComponent(...args: any[]): Promise<void>{
        const structureRef: StructureRef | undefined = getStructureRefWithModelId(this.plugin.managers.structure.hierarchy.current.structures, args[1]);
        if(structureRef == null)
            throw 'createComponent error: model not found';
        if (args.length === 4 && typeof args[2] === 'string') {
            await this.createComponentFromChain(args[0], structureRef, args[2], args[3]);
        } else if (args.length === 4 && args[2] instanceof Array) {
            await this.createComponentFromSet(args[0], structureRef, args[2], args[3]);
        } else if (args.length === 6) {
            await this.createComponentFromRange(args[0], structureRef, args[2], args[3], args[4], args[5]);
        }
    }
    private async createComponentFromChain(componentLabel: string, structureRef: StructureRef, asymId: string, representationType: StructureRepresentationRegistry.BuiltIn): Promise<void>{
        const selection: StructureSelectionQuery = StructureSelectionQuery(
            'innerQuery_' + Math.random().toString(36).substr(2),
            MolScriptBuilder.struct.generator.atomGroups({
                'chain-test': MolScriptBuilder.core.rel.eq([asymId, MolScriptBuilder.ammp('label_asym_id')])
            }));
        await this.plugin.managers.structure.component.add({
            selection: selection,
            options: {checkExisting: false, label: componentLabel},
            representation: representationType,
        }, [structureRef]);
    }
    private async createComponentFromSet(componentLabel: string, structureRef: StructureRef, residues: Array<{asymId: string, position: number}>, representationType: StructureRepresentationRegistry.BuiltIn): Promise<void>{
        await this.plugin.managers.structure.component.add({
            selection: StructureSelectionQuery(
                'innerQuery_' + Math.random().toString(36).substr(2),
                MolScriptBuilder.struct.combinator.merge(
                    residues.map(r=>MolScriptBuilder.struct.generator.atomGroups({
                        'chain-test': MolScriptBuilder.core.rel.eq([r.asymId, MolScriptBuilder.ammp('label_asym_id')]),
                        'residue-test': MolScriptBuilder.core.rel.eq([r.position, MolScriptBuilder.ammp('label_seq_id')])
                    }))
                )
            ),
            options: { checkExisting: false, label: componentLabel },
            representation: representationType,
        }, [structureRef]);
    }
    private async createComponentFromRange(componentLabel: string, structureRef: StructureRef, asymId: string, begin: number, end: number, representationType: StructureRepresentationRegistry.BuiltIn): Promise<void>{
        const seq_id: Array<number> = new Array<number>();
        for(let n = begin; n <= end; n++){
            seq_id.push(n);
        }
        await this.plugin.managers.structure.component.add({
            selection: StructureSelectionQuery(
                'innerQuery_' + Math.random().toString(36).substr(2),
                MolScriptBuilder.struct.generator.atomGroups({
                    'chain-test': MolScriptBuilder.core.rel.eq([asymId, MolScriptBuilder.ammp('label_asym_id')]),
                    'residue-test': MolScriptBuilder.core.set.has([MolScriptBuilder.set(...SetUtils.toArray(new Set(seq_id))), MolScriptBuilder.ammp('label_seq_id')])
                })
            ),
            options: { checkExisting: false, label: componentLabel },
            representation: representationType,
        }, [structureRef]);
    }

    public removeComponent(componentLabel: string): void{
        this.plugin.managers.structure.hierarchy.currentComponentGroups.forEach(c=>{
            for(const comp of c){
                if(comp.cell.obj?.label === componentLabel) {
                    this.plugin.managers.structure.hierarchy.remove(c);
                    break;
                }
            }
        });
    }
}

function getStructureRefWithModelId(structures: StructureRef[], modelId: string): StructureRef|undefined{
    for(const structure of structures){
        if(!structure.cell?.obj?.data?.units)
            continue;
        const unit =  structure.cell.obj.data.units[0];
        const id: string = unit.model.id;
        if(id === modelId)
            return structure;
    }
}

function getStructureWithModelId(structures: StructureRef[], modelId: string): Structure|undefined{
    const structureRef: StructureRef | undefined = getStructureRefWithModelId(structures, modelId);
    if(structureRef != null)
        return structureRef.cell?.obj?.data;
}

function getLociFromRange(plugin: PluginContext, modelId: string, asymId: string, begin: number, end: number): Loci | undefined {
    const data: Structure | undefined = getStructureWithModelId(plugin.managers.structure.hierarchy.current.structures, modelId);
    if (data == null) return;
    const seq_id: Array<number> = new Array<number>();
    for (let n = begin; n <= end; n++) {
        seq_id.push(n);
    }
    const sel: StructureSelection = Script.getStructureSelection(Q => Q.struct.generator.atomGroups({
        'chain-test': Q.core.rel.eq([asymId, MolScriptBuilder.ammp('label_asym_id')]),
        'residue-test': Q.core.set.has([MolScriptBuilder.set(...SetUtils.toArray(new Set(seq_id))), MolScriptBuilder.ammp('label_seq_id')])
    }), data);
    return StructureSelection.toLociWithSourceUnits(sel);
}