import { PluginContext } from 'molstar/lib/mol-plugin/context';
import { StateObjectRef, StateSelection } from 'molstar/lib/mol-state';
import { PluginStateObject } from 'molstar/lib/mol-plugin-state/objects';
import { StructureSelection, Structure } from 'molstar/lib/mol-model/structure';
import { CifExportContext, encode_mmCIF_categories } from 'molstar/lib/mol-model/structure/export/mmcif';
import { utf8ByteCount, utf8Write } from 'molstar/lib/mol-io/common/utf8';
import { Zip } from 'molstar/lib/mol-util/zip/zip';
import { getFormattedTime } from 'molstar/lib/mol-util/date';
import { download } from 'molstar/lib/mol-util/download';
import { CustomPropertyDescriptor } from 'molstar/lib/mol-model/custom-property';
import { CifWriter } from 'molstar/lib/mol-io/writer/cif';

type encode_mmCIF_categories_Params = {
    skipCategoryNames?: Set<string>,
    exportCtx?: CifExportContext,
    copyAllCategories?: boolean,
    customProperties?: CustomPropertyDescriptor[]
}

function exportParams(): encode_mmCIF_categories_Params {
    const skipCategories: Set<string> = new Set();
    skipCategories
        // Basics
        .add('entry')
        // Symmetry
        .add('cell')
        .add('symmetry')
        // Secondary structure
        .add('struct_conf')
        .add('struct_sheet_range')
        // Assemblies
        .add('pdbx_struct_assembly')
        .add('pdbx_struct_assembly_gen')
        .add('pdbx_struct_oper_list');
    return {
        skipCategoryNames: skipCategories
    };
}

function to_mmCIF(name: string, structure: Structure, asBinary = false) {
    const enc = CifWriter.createEncoder({ binary: asBinary });
    enc.startDataBlock(name);
    encode_mmCIF_categories(enc, structure, exportParams());
    return enc.getData();
}

function getDecorator(plugin: PluginContext, root: string): string {
    const tree = plugin.state.data.tree;
    const children = tree.children.get(root);
    if (children.size !== 1) return root;
    const child = children.first();
    if (tree.transforms.get(child).transformer.definition.isDecorator) {
        return getDecorator(plugin, child);
    }
    return root;
}

function extractStructureDataFromState(plugin: PluginContext): { [k: string]: Structure } {
    const content: { [k: string]: Structure } = Object.create(null);
    const cells = plugin.state.data.select(StateSelection.Generators.rootsOfType(PluginStateObject.Molecule.Structure));
    for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        // get decorated root structure
        const rootRef = getDecorator(plugin, c.transform.ref);
        const rootCell = StateObjectRef.resolveAndCheck(plugin.state.data, rootRef);
        // get all leaf children of root
        const children = plugin.state.data.tree.children.get(rootRef).toArray()
            .map(x => plugin.state.data.select(StateSelection.Generators.byRef(x!))[0])
            .filter(c => c.obj?.type === PluginStateObject.Molecule.Structure.type)
            .map(x => x.obj!.data as Structure);
        // merge children
        const sele = StructureSelection.Sequence(rootCell!.obj!.data, children);
        const structure = StructureSelection.unionStructure(sele);
        const name = `${i + 1}-${structure.model.entryId}`;
        content[name] = structure;
    }
    return content;
}

export function encodeStructureData(plugin: PluginContext): { [k: string]: Uint8Array } {
    const content: { [k: string]: Uint8Array } = Object.create(null);
    const structures = extractStructureDataFromState(plugin);
    for (const [key, structure] of Object.entries(structures)) {
        const filename = `${key}.cif`;
        const str = to_mmCIF(filename, structure, false) as string;
        const data = new Uint8Array(utf8ByteCount(str));
        utf8Write(data, 0, str);
        content[filename] = data;
    }
    return content;
}

export async function downloadAsZipFile(plugin: PluginContext, content: { [k: string]: Uint8Array }) {
    const filename = `mol-star_download_${getFormattedTime()}.zip`;
    const buf = await plugin.runTask(Zip(content));
    download(new Blob([buf], { type: 'application/zip' }), filename);
}
