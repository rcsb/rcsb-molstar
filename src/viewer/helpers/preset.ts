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
import { InitVolumeStreaming } from 'molstar/lib/mol-plugin/behavior/dynamic/volume-streaming/transformers';
import { ViewerState } from '../types';
import {
    StateSelection,
    StateObjectSelector,
    StateObject,
    StateTransformer
} from 'molstar/lib/mol-state';
import { VolumeStreaming } from 'molstar/lib/mol-plugin/behavior/dynamic/volume-streaming/behavior';
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra';
import { CustomStructureProperties } from 'molstar/lib/mol-plugin-state/transforms/model';
import { FlexibleStructureFromModel } from './superpose/flexible-structure';
import { PluginCommands } from 'molstar/lib/mol-plugin/commands';
import { InteractivityManager } from 'molstar/lib/mol-plugin-state/manager/interactivity';
import { MembraneOrientationPreset } from 'molstar/lib/extensions/anvil/behavior';
import { createSelectionExpression, Range, SelectionExpression, Target, targetToLoci, toRange } from './selection';
import { RcsbSuperpositionRepresentationPreset } from './superpose/preset';

type BaseProps = {
    assemblyId?: string
    modelIndex?: number
}

type ColorProp = {
    name: 'color',
    value: number,
    positions: Range[]
};

export type PropsetProps = {
    kind: 'prop-set',
    selection?: (Range & {
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
    target: Target
} & BaseProps

export type MotifProps = {
    kind: 'motif',
    label: string,
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
    isApplicable: () => {
        return true;
    },
    params: RcsbParams,
    async apply(trajectory, params, plugin) {
        const builder = plugin.builders.structure;
        const p = params.preset;

        const modelParams = { modelIndex: p.modelIndex || 0 };

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
                .apply(FlexibleStructureFromModel, { selection: p.selection });
            structure = await _structure.commit();

            const _structureProperties = plugin.state.data.build().to(structure)
                .apply(CustomStructureProperties);
            structureProperties = await _structureProperties.commit();

            // adding coloring lookup scheme
            structure.data!.inheritedPropertyData.colors = Object.create(null);
            for (const repr of p.representation) {
                if (repr.name === 'color') {
                    const colorValue = repr.value;
                    const positions = repr.positions;
                    for (const range of positions) {
                        if (!structure.data!.inheritedPropertyData.colors[range.label_asym_id])
                            structure.data!.inheritedPropertyData.colors[range.label_asym_id] = new Map();
                        const residues: number[] = (range.label_seq_id) ? toRange(range.label_seq_id.beg, range.label_seq_id.end) : [];
                        for (const num of residues) {
                            structure.data!.inheritedPropertyData.colors[range.label_asym_id].set(num, colorValue);
                        }
                    }
                }
            }

            // At this we have a structure that contains only the transformed substructres,
            // creating structure selections to have multiple components per each flexible part
            const entryId = model.data!.entryId;
            let selectionExpressions: SelectionExpression[] = [];
            if (p.selection) {
                for (const range of p.selection) {
                    selectionExpressions = selectionExpressions.concat(createSelectionExpression(entryId, range));
                }
            } else {
                selectionExpressions = selectionExpressions.concat(createSelectionExpression(entryId));
            }

            const params = {
                ignoreHydrogens: CommonParams.ignoreHydrogens.defaultValue,
                quality: CommonParams.quality.defaultValue,
                theme: { globalName: 'superpose' as any, focus: { name: 'superpose' } },
                selectionExpressions: selectionExpressions
            };
            representation = await plugin.builders.structure.representation.applyPreset(structureProperties!, RcsbSuperpositionRepresentationPreset, params);
        } else if (p.kind === 'motif') {
            let selectionExpressions = createSelectionExpression(p.label, p.targets);
            const globalExpressions = createSelectionExpression(p.label); // global reps, to be hidden
            selectionExpressions = selectionExpressions.concat(globalExpressions.map(e => { return { ...e, isHidden: true }; }));

            const params = {
                ignoreHydrogens: true,
                quality: CommonParams.quality.defaultValue,
                theme: { globalName: 'superpose' as any, focus: { name: 'superpose' } },
                selectionExpressions: selectionExpressions
            };
            representation = await plugin.builders.structure.representation.applyPreset(structureProperties!, RcsbSuperpositionRepresentationPreset, params);
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
                await initVolumeStreaming(plugin, structure);
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

async function initVolumeStreaming(plugin: PluginContext, structure: StructureObject) {
    if (!structure?.cell?.parent) return;

    const volumeRoot = StateSelection.findTagInSubtree(structure.cell.parent.tree, structure.cell.transform.ref, VolumeStreaming.RootTag);
    if (!volumeRoot) {
        const params = PD.getDefaultValues(InitVolumeStreaming.definition.params!(structure.obj!, plugin));
        await plugin.runTask(plugin.state.data.applyAction(InitVolumeStreaming, params, structure.ref));
    }

    ViewerState(plugin).collapsed.next({
        ...ViewerState(plugin).collapsed.value,
        volume: false
    });
}
