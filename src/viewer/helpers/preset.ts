/**
 * Copyright (c) 2020 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { PluginContext } from 'molstar/lib/mol-plugin/context';
import { ParamDefinition as PD } from 'molstar/lib/mol-util/param-definition';
import { TrajectoryHierarchyPresetProvider } from 'molstar/lib/mol-plugin-state/builder/structure/hierarchy-preset';
import { ValidationReportGeometryQualityPreset } from 'molstar/lib/extensions/rcsb/validation-report/behavior';
import { AssemblySymmetryPreset } from 'molstar/lib/extensions/rcsb/assembly-symmetry/behavior';
import { PluginStateObject } from 'molstar/lib/mol-plugin-state/objects';
import { RootStructureDefinition } from 'molstar/lib/mol-plugin-state/helpers/root-structure';
import { StructureRepresentationPresetProvider } from 'molstar/lib/mol-plugin-state/builder/structure/representation-preset';
import { StructureElement } from 'molstar/lib/mol-model/structure';
import { ViewerState } from '../types';
import {
    StateSelection,
    StateObjectSelector,
    StateObject,
    StateTransformer
} from 'molstar/lib/mol-state';
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra';
import { CustomStructureProperties } from 'molstar/lib/mol-plugin-state/transforms/model';
import { FlexibleStructureFromModel } from './superpose/flexible-structure';
import { PluginCommands } from 'molstar/lib/mol-plugin/commands';
import { InteractivityManager } from 'molstar/lib/mol-plugin-state/manager/interactivity';
import { MembraneOrientationPreset } from 'molstar/lib/extensions/anvil/behavior';
import { setSubtreeVisibility } from 'molstar/lib/mol-plugin/behavior/static/state';
import { VolumeStreaming } from 'molstar/lib/mol-plugin/behavior/dynamic/volume-streaming/behavior';
import {
    InitVolumeStreaming,
    VolumeStreamingVisual
} from 'molstar/lib/mol-plugin/behavior/dynamic/volume-streaming/transformers';
import {
    createSelectionExpressions,
    normalizeTargets,
    SelectionExpression,
    Target,
    targetToLoci,
    toRange
} from './selection';
import { RcsbSuperpositionRepresentationPreset } from './superpose/preset';

type BaseProps = {
    assemblyId?: string
    modelIndex?: number
}

type ColorProp = {
    name: 'color',
    value: number,
    targets: Target[]
};

export type PropsetProps = {
    kind: 'prop-set',
    targets?: (Target & {
        matrix?: Mat4
    })[],
    representation: ColorProp[]
} & BaseProps

export type EmptyProps = {
    kind: 'empty'
} & BaseProps

type ValidationProps = {
    kind: 'validation'
    colorTheme?: string
    showClashes?: boolean
} & BaseProps

type StandardProps = {
    kind: 'standard'
} & BaseProps

type SymmetryProps = {
    kind: 'symmetry'
    symmetryIndex?: number
} & BaseProps

type FeatureProps = {
    kind: 'feature'
    target: Target
} & BaseProps

type DensityProps = {
    kind: 'density'
} & BaseProps

type MembraneProps = {
    kind: 'membrane',
} & BaseProps

type FeatureDensityProps = {
    kind: 'feature-density',
    target: Target,
    radius?: number,
    hiddenChannels?: string[]
} & BaseProps

export type MotifProps = {
    kind: 'motif',
    label?: string,
    targets: Target[],
    color?: number
} & BaseProps

export type PresetProps = ValidationProps | StandardProps | SymmetryProps | FeatureProps | DensityProps | PropsetProps |
MembraneProps | FeatureDensityProps | MotifProps | EmptyProps;

const RcsbParams = () => ({
    preset: PD.Value<PresetProps>({ kind: 'standard', assemblyId: '' }, { isHidden: true })
});

type StructureObject = StateObjectSelector<PluginStateObject.Molecule.Structure, StateTransformer<StateObject<any, StateObject.Type<any>>, StateObject<any, StateObject.Type<any>>, any>>

const CommonParams = StructureRepresentationPresetProvider.CommonParams;

export const RcsbPreset = TrajectoryHierarchyPresetProvider({
    id: 'preset-trajectory-rcsb',
    display: { name: 'RCSB' },
    isApplicable: () => true,
    params: RcsbParams,
    async apply(trajectory, params, plugin) {
        const builder = plugin.builders.structure;
        const p = params.preset;

        const modelParams = { modelIndex: p.modelIndex || 0 };
        // jump through some hoops to determine the unknown assemblyId of query selections
        if (p.kind === 'motif') determineAssemblyId(trajectory, p);

        const structureParams: RootStructureDefinition.Params = { name: 'model', params: {} };
        if (p.assemblyId && p.assemblyId !== '' && p.assemblyId !== '0') {
            Object.assign(structureParams, {
                name: 'assembly',
                params: { id: p.assemblyId }
            } as RootStructureDefinition.Params);
        }

        const model = await builder.createModel(trajectory, modelParams);
        const modelProperties = await builder.insertModelProperties(model);

        let structure: StructureObject | undefined = undefined;
        let structureProperties: StructureObject | undefined = undefined;
        let unitcell: StateObjectSelector | undefined = undefined;
        // If flexible transformation is allowed, we may need to create a single structure component
        // from transformed substructures
        const allowsFlexTransform = p.kind === 'prop-set';
        if (!allowsFlexTransform) {
            structure = await builder.createStructure(modelProperties || model, structureParams);
            structureProperties = await builder.insertStructureProperties(structure);

            // hide unit cell when dealing with motifs
            if (p.kind !== 'motif') {
                unitcell = await builder.tryCreateUnitcell(modelProperties, undefined, { isHidden: true });
            }
        }

        let representation: StructureRepresentationPresetProvider.Result | undefined = undefined;

        if (p.kind === 'prop-set') {
            // This creates a single structure from selections/transformations as specified
            const _structure = plugin.state.data.build().to(modelProperties)
                .apply(FlexibleStructureFromModel, { targets: p.targets });
            structure = await _structure.commit();

            const _structureProperties = plugin.state.data.build().to(structure)
                .apply(CustomStructureProperties);
            structureProperties = await _structureProperties.commit();

            // adding coloring lookup scheme
            structure.data!.inheritedPropertyData.colors = Object.create(null);
            for (const repr of p.representation) {
                if (repr.name === 'color') {
                    const colorValue = repr.value;
                    const targets = repr.targets;
                    for (const target of targets) {
                        if (!target.label_asym_id) continue;

                        if (!structure.data!.inheritedPropertyData.colors[target.label_asym_id])
                            structure.data!.inheritedPropertyData.colors[target.label_asym_id] = new Map();
                        const residues: number[] = (target.label_seq_range) ? toRange(target.label_seq_range.beg, target.label_seq_range.end) : [];
                        for (const num of residues) {
                            structure.data!.inheritedPropertyData.colors[target.label_asym_id].set(num, colorValue);
                        }
                    }
                }
            }

            // At this we have a structure that contains only the transformed substructres,
            // creating structure selections to have multiple components per each flexible part
            const entryId = model.data!.entryId;
            let selectionExpressions: SelectionExpression[] = [];
            if (p.targets) {
                for (const target of p.targets) {
                    selectionExpressions = selectionExpressions.concat(createSelectionExpressions(entryId, target));
                }
            } else {
                selectionExpressions = selectionExpressions.concat(createSelectionExpressions(entryId));
            }

            const params = {
                ignoreHydrogens: CommonParams.ignoreHydrogens.defaultValue,
                quality: CommonParams.quality.defaultValue,
                theme: { globalName: 'superpose', focus: { name: 'superpose' } },
                selectionExpressions: selectionExpressions
            };
            representation = await plugin.builders.structure.representation.applyPreset<any>(structureProperties!, RcsbSuperpositionRepresentationPreset, params);
        } else if (p.kind === 'motif' && structure?.obj) {
            // let's force ASM_1 for motifs (as we use this contract in the rest of the stack)
            // TODO should ASM_1 be the default, seems like we'd run into problems when selecting ligands that are e.g. ambiguous with asym_id & seq_id alone?
            const targets = normalizeTargets(p.targets, structure!.obj.data);
            let selectionExpressions = createSelectionExpressions(p.label || model.data!.entryId, targets);
            const globalExpressions = createSelectionExpressions(p.label || model.data!.entryId); // global reps, to be hidden
            selectionExpressions = selectionExpressions.concat(globalExpressions.map(e => { return { ...e, isHidden: true }; }));

            if (p.color) {
                selectionExpressions = selectionExpressions.map(e => { return { ...e, color: p.color }; });
            }

            const params = {
                ignoreHydrogens: true,
                quality: CommonParams.quality.defaultValue,
                selectionExpressions: selectionExpressions
            };
            representation = await plugin.builders.structure.representation.applyPreset<any>(structureProperties!, RcsbSuperpositionRepresentationPreset, params);
        } else if (p.kind === 'validation') {
            representation = await plugin.builders.structure.representation.applyPreset(structureProperties!, ValidationReportGeometryQualityPreset);
        } else if (p.kind === 'symmetry') {
            representation = await plugin.builders.structure.representation.applyPreset<any>(structureProperties!, AssemblySymmetryPreset, { symmetryIndex: p.symmetryIndex });

            ViewerState(plugin).collapsed.next({
                ...ViewerState(plugin).collapsed.value,
                custom: false
            });
        } else if (p.kind === 'empty') {
            console.warn('Using empty representation');
        } else if (p.kind === 'membrane') {
            representation = await plugin.builders.structure.representation.applyPreset(structureProperties!, MembraneOrientationPreset);
        } else {
            representation = await plugin.builders.structure.representation.applyPreset(structureProperties!, 'auto');
        }

        if ((p.kind === 'feature' || p.kind === 'feature-density') && structure?.obj) {
            let loci = targetToLoci(p.target, structure!.obj.data);
            // if target is only defined by chain: then don't force first residue
            const chainMode = p.target.label_asym_id && !p.target.auth_seq_id && !p.target.label_seq_id && !p.target.label_comp_id;
            // HELP-16678: check for rare case where ligand is not present in requested assembly
            if (loci.elements.length === 0 && !!p.assemblyId) {
                // switch to Model (a.k.a. show coordinates independent of assembly)
                const { selection } = plugin.managers.structure.hierarchy;
                const s = selection.structures[0];
                await plugin.managers.structure.hierarchy.updateStructure(s, { ...params, preset: { ...params.preset, assemblyId: void 0 } });
                // update loci
                loci = targetToLoci(p.target, structure!.obj.data);
            }
            const target = chainMode ? loci : StructureElement.Loci.firstResidue(loci);

            if (p.kind === 'feature-density') {
                await initVolumeStreaming(plugin, structure, { overrideRadius: p.radius || 0, hiddenChannels: p.hiddenChannels || ['fo-fc(+ve)', 'fo-fc(-ve)'] });
            }

            plugin.managers.structure.focus.setFromLoci(target);
            plugin.managers.camera.focusLoci(target);
        }

        if (p.kind === 'density' && structure) {
            await initVolumeStreaming(plugin, structure);

            await PluginCommands.Toast.Show(plugin, {
                title: 'Electron Density',
                message: 'Click on a residue to display electron density, click background to reset.',
                key: 'toast-density',
                timeoutMs: 60000
            });

            plugin.behaviors.interaction.click.subscribe(async (e: InteractivityManager.ClickEvent) => {
                if (e.current && e.current.loci && e.current.loci.kind !== 'empty-loci') {
                    await PluginCommands.Toast.Hide(plugin, { key: 'toast-density' });
                }
            });
        }

        return {
            model,
            modelProperties,
            unitcell,
            structure,
            structureProperties,
            representation
        };
    }
});

function determineAssemblyId(traj: any, p: MotifProps) {
    // nothing to do if assembly is known
    if (p.assemblyId && p.assemblyId !== '' && p.assemblyId !== '0') return;

    function equals(expr: string, val: string): boolean {
        const list = parseOperatorList(expr);
        const split = val.split('x');
        let matches = 0;
        for (let i = 0, il = Math.min(list.length, split.length); i < il; i++) {
            if (list[i].indexOf(split[i]) !== -1) matches++;
        }
        return matches === split.length;
    }

    function parseOperatorList(value: string): string[][] {
        // '(X0)(1-5)' becomes [['X0'], ['1', '2', '3', '4', '5']]
        // kudos to Glen van Ginkel.

        const oeRegex = /\(?([^()]+)\)?]*/g, groups: string[] = [], ret: string[][] = [];

        let g: any;
        while (g = oeRegex.exec(value)) groups[groups.length] = g[1];

        groups.forEach(g => {
            const group: string[] = [];
            g.split(',').forEach(e => {
                const dashIndex = e.indexOf('-');
                if (dashIndex > 0) {
                    const from = parseInt(e.substring(0, dashIndex)), to = parseInt(e.substr(dashIndex + 1));
                    for (let i = from; i <= to; i++) group[group.length] = i.toString();
                } else {
                    group[group.length] = e.trim();
                }
            });
            ret[ret.length] = group;
        });

        return ret;
    }

    // set of provided [struct_oper_id, label_asym_id] combinations
    const ids = p.targets.map(t => [t.struct_oper_id || '1', t.label_asym_id!]).filter((x, i, a) => a.indexOf(x) === i);

    try {
        // find first assembly that contains all requested struct_oper_ids - if multiple, the first will be returned
        const pdbx_struct_assembly_gen = traj.obj.data.representative.sourceData.data.frame.categories.pdbx_struct_assembly_gen;
        const assembly_id = pdbx_struct_assembly_gen.getField('assembly_id');
        const oper_expression = pdbx_struct_assembly_gen.getField('oper_expression');
        const asym_id_list = pdbx_struct_assembly_gen.getField('asym_id_list');

        for (let i = 0, il = pdbx_struct_assembly_gen.rowCount; i < il; i++) {
            if (ids.some(val => !equals(oper_expression.str(i), val[0]) || asym_id_list.str(i).indexOf(val[1]) === -1)) continue;

            Object.assign(p, { assemblyId: assembly_id.str(i) });
            return;
        }
    } catch (error) {
        console.warn(error);
    }
    // default to '1' if error or legitimately not found
    Object.assign(p, { assemblyId: '1' });
}

async function initVolumeStreaming(plugin: PluginContext, structure: StructureObject, props?: { overrideRadius?: number, hiddenChannels: string[] }) {
    if (!structure?.cell?.parent) return;

    const volumeRoot = StateSelection.findTagInSubtree(structure.cell.parent.tree, structure.cell.transform.ref, VolumeStreaming.RootTag);
    if (!volumeRoot) {
        const state = plugin.state.data;
        const params = PD.getDefaultValues(InitVolumeStreaming.definition.params!(structure.obj!, plugin));
        await plugin.runTask(state.applyAction(InitVolumeStreaming, params, structure.ref));

        // RO-2751: allow to specify radius of shown density
        if (props?.overrideRadius !== void 0) {
            const { params, transform } = state.select(StateSelection.Generators.ofType(VolumeStreaming))[0];

            const p = params?.values;
            (p.entry.params.view.params as any).radius = props.overrideRadius;

            await state.build().to(transform.ref).update(p).commit();
        }
        // RO-2751: hide all but 2Fo-Fc map
        if (props?.hiddenChannels?.length) {
            const cells = state.select(StateSelection.Generators.ofTransformer(VolumeStreamingVisual));
            for (const cell of cells) {
                if (props.hiddenChannels.indexOf(cell.obj!.tags![0]) !== -1) {
                    setSubtreeVisibility(state, cell.transform.ref, true);
                }
            }
        }
    }

    ViewerState(plugin).collapsed.next({
        ...ViewerState(plugin).collapsed.value,
        volume: false
    });
}
