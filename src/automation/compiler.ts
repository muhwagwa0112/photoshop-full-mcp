import type { AppId, ArtifactSpec, AssetBinding, EditPlan, Json, JsonObject, MaterializationGroup, PlanStep, RecipeRequest, TargetBinding } from './contracts.js';
import { OperationRegistry } from './registry.js';
import { validateDag } from './validation.js';
import { requireCondition } from './errors.js';
import { frameTicks } from './timeline.js';

type Params = Record<string, Json>;
const asObject = (value: Json | undefined): Params => (value ?? {}) as Params;
const source = (inputKey: string): AssetBinding => ({ kind: 'input', inputKey });
const output = (stepKey: string, slot = 'artifact', itemKey?: string): AssetBinding => ({ kind: 'step_output', stepKey, slot, ...(itemKey ? { itemKey } : {}) });
const target = (stepKey: string, slot: string, itemKey?: string): TargetBinding => ({ kind: 'step_output', stepKey, slot, ...(itemKey ? { itemKey } : {}) });
function json(value: unknown): Json { return structuredClone(value) as Json; }

export function compileRecipe(request: RecipeRequest, jobId: string, revisionId: string, registry: OperationRegistry): EditPlan {
  const steps: PlanStep[] = []; const groups: MaterializationGroup[] = []; const lastMutation = new Map<string, string>();
  const p = request.parameters as Params;
  function group(id: string, app: AppId, inputKey: string, role: string): string {
    groups.push({ groupId: id, app, rootResourceRole: role, base: source(inputKey), mutationOrder: [], checkpointPolicy: 'before_repair_and_publish' }); return id;
  }
  function add(key: string, operation: string, args: JsonObject, options: { target?: TargetBinding; assets?: Record<string, AssetBinding>; depends?: string[]; group?: string } = {}): string {
    const spec = registry.get(operation); const dependencies = new Set(options.depends ?? []);
    for (const binding of [options.target, ...Object.values(options.assets ?? {})]) if (binding?.kind === 'step_output') dependencies.add(binding.stepKey);
    if (options.group && lastMutation.has(options.group)) dependencies.add(lastMutation.get(options.group)!);
    const effect = spec.effect === 'mutable_host' ? { kind: 'mutable_host' as const, materializationGroupId: options.group! } : { kind: spec.effect };
    requireCondition(spec.effect !== 'mutable_host' || options.group, 'MATERIALIZATION_GROUP_REQUIRED', `Mutation ${key} requires a group.`);
    const step: PlanStep = { stepKey: key, operation, args, dependsOn: [...dependencies], effect, assertions: [], failureStrategy: 'reconcile', ...(options.target ? { target: options.target } : {}), ...(options.assets ? { assets: options.assets } : {}) };
    if (spec.effect === 'mutable_host') { lastMutation.set(options.group!, key); groups.find(item => item.groupId === options.group)!.mutationOrder.push(key); }
    registry.validateStep(step); steps.push(step); return key;
  }
  function psExport(prefix: string, document: TargetBinding, groupId: string, outputs: ArtifactSpec[], depends: string[] = []): void {
    let previous = depends;
    for (const spec of outputs) {
      let exportTarget = document; let exportGroup = groupId;
      if (spec.encoding.kind === 'image' && spec.color?.iccProfile) {
        const base = groups.find(item => item.groupId === groupId)!.base; requireCondition(base.kind === 'input', 'EXPORT_BASE_MISSING', 'Image derivation needs an immutable source.');
        exportGroup = group(`${prefix}.derivative.${spec.outputKey}`, 'photoshop', base.inputKey, 'document');
        const copy = add(`${prefix}.output.${spec.outputKey}.copy`, 'ps.document.duplicate', { name: spec.basename }, { target: document, group: exportGroup, depends: previous }); exportTarget = target(copy, 'document');
        const converted = add(`${prefix}.output.${spec.outputKey}.profile`, 'ps.document.convertProfile', { iccProfile: spec.color.iccProfile }, { target: exportTarget, group: exportGroup, depends: [copy] }); previous = [converted];
      }
      const key = add(`${prefix}.output.${spec.outputKey}`, spec.encoding.kind === 'native_project' ? 'ps.document.save' : 'ps.document.export', { output: json(spec) }, { target: exportTarget, group: exportGroup, depends: previous });
      previous = [key];
    }
    add(`${prefix}.evidence`, 'ps.evidence.capture', { kind: 'composite', maxEdge: 1600, evidenceKey: `${prefix}.final` }, { target: document, group: groupId, depends: previous });
  }
  function mask(prefix: string, layerTarget: TargetBinding, maskPolicy: Params, groupId: string, depends: string[]): string[] {
    const preview = (after: string[]): string[] => [add(`${prefix}.review`, 'ps.evidence.capture', { kind: 'layer', maxEdge: 1600, evidenceKey: `${prefix}.result` }, { target: layerTarget, depends: after })];
    if (!maskPolicy.source || maskPolicy.source === 'none') return preview(depends);
    let assets: Record<string, AssetBinding> | undefined;
    let maskSource = String(maskPolicy.source);
    if (maskPolicy.source === 'input_mask') assets = { mask: source(String(maskPolicy.inputKey)) };
    if (maskPolicy.source === 'local_model') {
      const snapshot = add(`${prefix}.snapshot`, 'ps.raster.capture', { evidenceKey: `${prefix}.source` }, { target: layerTarget, depends, group: groupId });
      const segmentation = add(`${prefix}.segment`, 'image.segment', { providerId: maskPolicy.providerId!, candidates: 3 }, { assets: { source: output(snapshot) }, depends: [snapshot] });
      assets = { mask: output(segmentation) }; depends = [segmentation]; maskSource = 'input_mask';
    }
    const key = add(`${prefix}.apply`, 'ps.layer.mask', { source: maskSource, featherPx: maskPolicy.featherPx ?? 0, contractPx: maskPolicy.contractPx ?? 0 }, { target: layerTarget, ...(assets ? { assets } : {}), depends, group: groupId });
    return preview([key]);
  }
  function roles(key: string, owners: { inputKey: string; inspectStepKey: string }[], requirements: { role: string; ownerInputKey: string; kind: string; layerKind?: string }[], useManifest = true): string {
    return add(key, 'workflow.roles.prepare', { owners: json(owners), roles: json(requirements), ...(useManifest && p.roleManifest === 'roleManifest' ? { manifestInputKey: 'roleManifest' } : {}) }, { depends: owners.map(owner => owner.inspectStepKey), ...(useManifest && p.roleManifest === 'roleManifest' ? { assets: { manifest: source('roleManifest') } } : {}) });
  }
  function finishVideo(project: TargetBinding, sequence: TargetBinding, groupId: string, depends: string[], captionsStepKey?: string, renderedCaptions = false): void {
    const inspected = add('timeline.final-inventory', 'pr.timeline.inspect', {}, { target: sequence, depends }); depends = [inspected];
    let renderedSubtitle: string | undefined;
    if (renderedCaptions) {
      requireCondition(captionsStepKey, 'CAPTION_DATA_MISSING', 'Rendered captions require actual mapped cues.');
      const temp: ArtifactSpec = { outputKey: 'rendered-captions-source', rootId: '__automation', relativeDirectory: `${jobId}/${revisionId}`, basename: 'rendered-captions-source', format: 'srt', encoding: { kind: 'subtitle', charset: 'utf-8', lineEnding: 'LF' }, collision: { onConflict: 'error', preserveSource: true } };
      renderedSubtitle = add('captions.render-source', 'artifact.publish', { output: json(temp) }, { assets: { source: output(captionsStepKey!) }, depends: [captionsStepKey!] });
    }
    for (const spec of request.delivery.outputs) {
      if (spec.format.toLowerCase() === 'prproj') add(`output.${spec.outputKey}`, 'pr.project.save', { output: json(spec) }, { target: project, group: groupId, depends });
      else if (spec.encoding.kind === 'video') {
        if (!renderedCaptions) add(`output.${spec.outputKey}`, 'pr.export', { output: json(spec) }, { target: sequence, group: groupId, depends });
        else {
          const rawSpec = { ...spec, outputKey: `raw-${spec.outputKey}`, rootId: '__automation', relativeDirectory: `${jobId}/${revisionId}`, basename: `raw-${spec.outputKey}`, collision: { onConflict: 'error', preserveSource: true } };
          const raw = add(`output.${spec.outputKey}.raw`, 'pr.export', { output: json(rawSpec) }, { target: sequence, group: groupId, depends });
          requireCondition(['mp4', 'mov'].includes(spec.format.toLowerCase()), 'CAPTION_RENDER_FORMAT_UNSUPPORTED', 'Rendered caption delivery supports explicit MP4 or MOV targets.');
          const conformed = add(`output.${spec.outputKey}.render`, 'media.conform', { outputFormat: spec.format.toLowerCase(), burnSubtitles: true, ...(spec.width ? { width: spec.width } : {}), ...(spec.height ? { height: spec.height } : {}), ...(spec.frameRate ? { frameRate: json(spec.frameRate) } : {}), pixelFormat: spec.encoding.pixelFormat, videoCodec: spec.encoding.videoCodec.toLowerCase().includes('prores') ? 'prores' : 'h264' }, { assets: { source: output(raw), subtitles: output(renderedSubtitle!) }, depends: [raw, renderedSubtitle!] });
          const verified = add(`output.${spec.outputKey}.verify`, 'artifact.verify', { output: json(spec) }, { assets: { source: output(conformed) }, depends: [conformed] });
          add(`output.${spec.outputKey}`, 'artifact.publish', { output: json(spec) }, { assets: { source: output(conformed) }, depends: [verified] });
        }
      }
      else if (spec.encoding.kind === 'image' && !['psd', 'psb'].includes(spec.format.toLowerCase()) && !request.recipeId.startsWith('cross.')) {
        requireCondition(['png', 'jpg', 'jpeg'].includes(spec.format.toLowerCase()), 'THUMBNAIL_FORMAT_UNSUPPORTED', 'Thumbnail output supports PNG or JPEG.');
        const frame = add(`output.${spec.outputKey}.frame`, 'pr.frame.capture', { ticks: '0', maxEdge: 2048, evidenceKey: `thumbnail.${spec.outputKey}.source` }, { target: sequence, group: groupId, depends });
        const image = add(`output.${spec.outputKey}.encode`, 'media.conform', { outputFormat: spec.format.toLowerCase() === 'jpeg' ? 'jpg' : spec.format.toLowerCase(), fit: 'contain', ...(spec.width ? { width: spec.width } : {}), ...(spec.height ? { height: spec.height } : {}), embedIcc: spec.encoding.embedIcc, ...(spec.encoding.jpegQuality !== undefined ? { jpegQuality: spec.encoding.jpegQuality } : {}) }, { assets: { source: output(frame) }, depends: [frame] });
        const verified = add(`output.${spec.outputKey}.verify`, 'artifact.verify', { output: json(spec) }, { assets: { source: output(image) }, depends: [image] });
        add(`output.${spec.outputKey}`, 'artifact.publish', { output: json(spec) }, { assets: { source: output(image) }, depends: [verified] });
      }
      else if (spec.encoding.kind === 'subtitle') {
        requireCondition(captionsStepKey, 'CAPTION_OUTPUT_WITHOUT_CUES', 'Subtitle delivery requires a captions producer.');
        add(`output.${spec.outputKey}`, 'artifact.publish', { output: json(spec) }, { assets: { source: output(captionsStepKey!) }, depends: [captionsStepKey!] });
      }
    }
    const titlePlacement = request.recipeId === 'cross.ps_title_to_premiere.v1' ? asObject(p.timelinePlacement) : undefined;
    const finalTicks = titlePlacement ? frameTicks(String(BigInt(String(titlePlacement.startFrame)) + BigInt(String(titlePlacement.durationFrames)) / 2n), titlePlacement.frameRate as unknown as { num: number; den: number }) : '0';
    add('timeline.evidence', 'pr.frame.capture', { ticks: finalTicks, maxEdge: 1600, evidenceKey: 'timeline.final' }, { target: sequence, group: groupId, depends });
    for (const [index, raw] of ((p.brollPlan as JsonObject[]) ?? []).entries()) add(`timeline.broll-evidence.${index}`, 'pr.frame.capture', { ticks: frameTicks(String((BigInt(String(raw.fromFrame)) + BigInt(String(raw.toFrame))) / 2n), p.sequenceRate as unknown as { num: number; den: number }), maxEdge: 1280, evidenceKey: `interview.broll.frames.${index}` }, { target: sequence, depends });
    for (const [index, raw] of ((p.anglePlan as JsonObject[]) ?? []).entries()) add(`timeline.angle-evidence.${index}`, 'pr.frame.capture', { ticks: frameTicks(String((BigInt(String(raw.fromFrame)) + BigInt(String(raw.toFrame))) / 2n), p.frameRate as unknown as { num: number; den: number }), maxEdge: 1280, evidenceKey: `multicam.angle.frames.${index}` }, { target: sequence, depends });
  }

  if (request.recipeId === 'ps.photo_composite.v1') {
    const gid = group('photo', 'photoshop', 'photo', 'document'); const canvas = asObject(p.canvas);
    const sourceGroup = group('photo.source', 'photoshop', 'photo', 'document');
    const sourceInfo = add('photo.source.open', 'ps.document.open', { name: 'Source photo inspection' }, { assets: { source: source('photo') }, group: sourceGroup });
    const colorPolicy = asObject(p.colorPolicy);
    const docKey = add('document.create', 'ps.document.create', { width: canvas.width!, height: canvas.height!, name: 'Composite', sourceInfoStepKey: sourceInfo, preserveSourceColor: colorPolicy.mode === 'preserve_input', ...(colorPolicy.mode === 'convert_working' ? { colorProfile: colorPolicy.iccProfile! } : {}) }, { group: gid, depends: [sourceInfo] }); const doc = target(docKey, 'document');
    const bg = asObject(p.background); let background: string;
    if (bg.kind === 'color') background = add('background.fill', 'ps.layer.fill', { color: bg.color!, name: 'Background' }, { target: doc, group: gid });
    else background = add('background.place', 'ps.layer.place', { box: { x: 0, y: 0, width: canvas.width!, height: canvas.height! }, fit: bg.fit ?? 'cover', name: 'Background' }, { target: doc, assets: { source: source(String(bg.inputKey)) }, group: gid });
    const subject = asObject(p.subject); const box = asObject(subject.box);
    const placed = add('subject.place', 'ps.layer.place', { box: { x: Number(box.x) * Number(canvas.width), y: Number(box.y) * Number(canvas.height), width: Number(box.width) * Number(canvas.width), height: Number(box.height) * Number(canvas.height) }, fit: subject.fit ?? 'contain', name: 'Subject' }, { target: doc, assets: { source: source('photo') }, group: gid });
    const photoGeometry: JsonObject = { sourceInfoStepKey: sourceInfo, placedStepKey: placed };
    let previous = mask('subject.mask', target(placed, 'layer'), asObject(subject.mask), gid, [placed]);
    for (let index = 0; index < ((p.adjustments as Json[]) ?? []).length; index++) {
      const adjustment = asObject((p.adjustments as Json[])[index]); const { kind, target: adjustmentTarget, ...values } = adjustment;
      const key = add(`adjustment.${index}`, 'ps.adjustment.create', { kind: kind!, values }, { target: adjustmentTarget === 'subject' ? target(placed, 'layer') : adjustmentTarget === 'background' ? target(background, 'layer') : doc, group: gid, depends: previous }); previous = [key];
    }
    for (const raw of (p.retouch as Json[]) ?? []) {
      const retouch = asObject(raw); const repairSource = asObject(retouch.source); let assets: Record<string, AssetBinding>;
      if (repairSource.kind === 'asset_patch') assets = { patch: source(String(repairSource.inputKey)) };
      else if (repairSource.kind === 'clone') assets = {};
      else {
        const snapshot = add(`retouch.${retouch.key}.snapshot`, 'ps.raster.capture', { evidenceKey: `retouch.${retouch.key}.before` }, { target: doc, group: gid, depends: previous });
        if (repairSource.kind === 'local_restore') {
          const patch = add(`retouch.${retouch.key}.inpaint`, 'image.inpaint', { region: retouch.region!, photoGeometry, method: 'telea', radiusPx: 3, providerId: repairSource.providerId!, featherPx: retouch.featherPx ?? 2 }, { assets: { source: output(snapshot) }, depends: [snapshot, sourceInfo, placed] }); assets = { patch: output(patch) }; previous = [patch];
        } else { assets = { source: output(snapshot) }; previous = [snapshot]; }
      }
      const key = add(`retouch.${retouch.key}.apply`, 'ps.layer.patch', { region: retouch.region!, photoGeometry, ...(repairSource.kind === 'clone' ? { sourceRegion: repairSource.sourceRegion! } : {}), featherPx: retouch.featherPx ?? 2, opacityPercent: retouch.opacityPercent ?? 100 }, { target: doc, assets, group: gid, depends: [...previous, sourceInfo, placed] }); previous = [key];
    }
    psExport('photo', doc, gid, request.delivery.outputs, previous);
  } else if (request.recipeId === 'ps.product_variants.v1' || request.recipeId === 'ps.social_layout.v1') {
    const social = request.recipeId === 'ps.social_layout.v1'; const roleNames = asObject(p.roles); const variants = p.variants as Params[];
    for (let index = 0; index < variants.length; index++) {
      const variant = variants[index]!; const prefix = `variant.${variant.key}`; const gid = group(prefix, 'photoshop', 'template', 'document');
      const nativeBoards = p.variantMode === 'native_artboards';
      const sourceGroup = nativeBoards ? group(`${prefix}.template`, 'photoshop', 'template', 'document') : gid;
      const opened = add(`${prefix}.open`, 'ps.document.open', { name: String(variant.key) }, { assets: { source: source('template') }, group: sourceGroup }); let doc = target(opened, 'document');
      let inspected = add(`${prefix}.inspect`, 'ps.document.inspect', {}, { target: doc, group: sourceGroup });
      if (nativeBoards) {
        const boardRole = `${prefix}.source-artboard`;
        const sourceBoard = roles(`${prefix}.artboard-role`, [{ inputKey: 'template', inspectStepKey: inspected }], [{ role: boardRole, ownerInputKey: 'template', kind: 'ps_layer', layerKind: 'artboard' }], false);
        const duplicated = add(`${prefix}.artboard`, 'ps.artboard.duplicate', { name: String(variant.key), box: { x: 0, y: 0, width: variant.width!, height: variant.height! } }, { target: target(sourceBoard, `role:${boardRole}`), group: gid, depends: [sourceBoard] });
        doc = target(duplicated, 'document');
        inspected = add(`${prefix}.artboard.inspect`, 'ps.document.inspect', {}, { target: target(duplicated, 'layer'), group: gid });
      }
      const contentRole = String(roleNames[social ? 'subject' : 'product']); const titleRole = String(roleNames.title); const logoRole = String(roleNames.logo);
      const requirements = [{ role: contentRole, ownerInputKey: 'template', kind: 'ps_layer' }, { role: titleRole, ownerInputKey: 'template', kind: 'ps_layer', layerKind: 'text' }, { role: logoRole, ownerInputKey: 'template', kind: 'ps_layer' }];
      if (social && roleNames.subtitle) requirements.push({ role: String(roleNames.subtitle), ownerInputKey: 'template', kind: 'ps_layer', layerKind: 'text' });
      const bound = roles(`${prefix}.roles`, [{ inputKey: 'template', inspectStepKey: inspected }], requirements);
      const resized = nativeBoards ? bound : add(`${prefix}.resize`, 'ps.document.resize', { width: variant.width!, height: variant.height!, fit: p.fit ?? 'contain' }, { target: doc, group: gid, depends: [bound] });
      if (p.backgroundColor) add(`${prefix}.background`, 'ps.layer.fill', { color: p.backgroundColor, name: 'Background', placement: 'back' }, { target: doc, group: gid });
      const layout = asObject(p.layout); const toPixels = (value: Json | undefined): Json => { const box = asObject(value); return { x: Number(box.x) * Number(variant.width), y: Number(box.y) * Number(variant.height), width: Number(box.width) * Number(variant.width), height: Number(box.height) * Number(variant.height) }; };
      const content = add(`${prefix}.content`, 'ps.placeholder.replace', { fit: p.fit ?? 'contain', roleStepKey: bound, role: contentRole, ...(social ? { box: toPixels(layout.subjectBox) } : {}) }, { target: target(bound, `role:${contentRole}`), assets: { source: source(social ? 'subject' : 'product') }, group: gid, depends: [resized] });
      let previous = mask(`${prefix}.mask`, target(content, 'layer'), asObject(p.mask), gid, [content]);
      const logo = add(`${prefix}.logo`, 'ps.placeholder.replace', { fit: 'contain', roleStepKey: bound, role: logoRole, ...(social ? { box: toPixels(layout.logoBox) } : {}) }, { target: target(bound, `role:${logoRole}`), assets: { source: source('logo') }, group: gid, depends: previous }); previous = [logo];
      const titleText = variant.title ?? p.title ?? '';
      if (social) previous = [add(`${prefix}.title`, 'ps.text.fit', { text: titleText, box: toPixels(layout.titleBox), font: p.font! }, { target: target(bound, `role:${titleRole}`), group: gid, depends: previous })];
      else previous = [add(`${prefix}.title`, 'ps.text.set', { text: titleText, ...(p.font ? { fontPostScriptName: asObject(p.font).postScriptName! } : {}) }, { target: target(bound, `role:${titleRole}`), group: gid, depends: previous })];
      if (social && roleNames.subtitle && p.subtitle !== undefined) previous = [add(`${prefix}.subtitle`, 'ps.text.fit', { text: p.subtitle, box: toPixels(layout.subtitleBox), font: p.font! }, { target: target(bound, `role:${String(roleNames.subtitle)}`), group: gid, depends: previous })];
      const outputs = request.delivery.outputs.filter(spec => spec.variantKey === variant.key || (!spec.variantKey && index === 0)); psExport(prefix, doc, gid, outputs, previous);
    }
  } else if (request.recipeId === 'pr.interview_captioned.v1' || request.recipeId === 'pr.multicam_edit.v1') {
    const interview = request.recipeId === 'pr.interview_captioned.v1'; const cameraKeys = interview ? ['camera'] : p.cameraInputs as string[]; const audioKey = interview ? 'voice' : String(p.audioInput);
    const gid = group('timeline', 'premiere', cameraKeys[0]!, 'sequence');
    requireCondition(p.nativeMulticamRequired !== true, 'BLOCKED_CAPABILITY', 'Native multicam source construction requires its own qualified host route; this compiler preserves editable ordinary camera tracks.');
    if (!interview) requireCondition(p.ordinaryEditableTrackFallbackAllowed === true && request.delivery.allowedFallbacks.includes('native_equivalent'), 'BLOCKED_CAPABILITY', 'Editable ordinary camera tracks require both the recipe fallback flag and native_equivalent delivery authorization.');
    const allKeys = [...new Set([...cameraKeys, audioKey, ...(p.ducking ? ['music'] : []), ...((p.brollPlan as Params[]) ?? []).map(item => String(item.inputKey))])];
    const inputAssets = Object.fromEntries([...new Set(allKeys)].map(key => [key, source(key)]));
    const inspectKeys = allKeys.map(key => add(`media.${key}.inspect`, 'media.inspect', {}, { assets: { source: source(key) } }));
    const syncKey = add('media.sync', 'audio.sync', { sync: p.sync!, inputKeys: json([...(new Set([...cameraKeys, audioKey]))]) }, { assets: inputAssets, depends: inspectKeys });
    let transcript: string | undefined; let analysis: string | undefined;
    if (interview) {
      const captions = asObject(p.captions);
      if (captions.source === 'local_asr' || asObject(p.editIntent).preserveSpeechMeaning === true || p.ducking) transcript = add('speech.transcribe', 'media.transcribe', { language: p.language!, ...(captions.providerId ? { providerId: captions.providerId } : {}) }, { assets: { source: source(audioKey) }, depends: inspectKeys });
      analysis = add('speech.analyze', 'audio.analyze', { minimumSilenceMs: asObject(asObject(p.editIntent).silenceCuts).minimumSilenceMs ?? 800 }, { assets: { source: source(audioKey) }, depends: inspectKeys });
    }
    const cutMap = add('timeline.cutmap', 'pr.cut_map.build', { recipeId: request.recipeId, parameters: p, syncStepKey: syncKey, ...(transcript ? { transcriptStepKey: transcript } : {}), ...(analysis ? { analysisStepKey: analysis } : {}) }, { depends: [syncKey, ...(transcript ? [transcript] : []), ...(analysis ? [analysis] : []), ...inspectKeys] });
    const project = add('project.create', 'pr.project.create', { name: request.brief.slice(0, 100) }, { group: gid, depends: [cutMap] });
    const imported = add('media.import', 'pr.media.import', { items: json(allKeys.map(key => ({ itemKey: key, inputKey: key }))) }, { target: target(project, 'project'), assets: inputAssets, group: gid });
    const videoOutput = request.delivery.outputs.find(spec => spec.encoding.kind === 'video')!;
    requireCondition(videoOutput.width && videoOutput.height, 'OUTPUT_DIMENSIONS_REQUIRED', 'A new sequence requires explicit video width and height.');
    const sequenceKey = add('sequence.create', 'pr.sequence.create', { name: 'Edited sequence', width: videoOutput.width, height: videoOutput.height, frameRate: p.sequenceRate ?? p.frameRate! }, { target: target(project, 'project'), group: gid }); const sequenceTarget = target(sequenceKey, 'sequence');
    const assembled = add('timeline.assemble', 'pr.timeline.assemble', { cutMapStepKey: cutMap, importStepKey: imported, cameraInputs: json(cameraKeys), audioInput: audioKey }, { target: sequenceTarget, group: gid, depends: [cutMap, imported] });
    let finalSteps = [assembled]; let captionsStep: string | undefined;
    if (asObject(p.colorMatch).enabled === true) finalSteps = [add('timeline.color-match', 'pr.color.match', { settings: p.colorMatch!, cameraInputs: json(cameraKeys), assemblyStepKey: assembled, syncStepKey: syncKey }, { target: sequenceTarget, group: gid, depends: finalSteps })];
    const audioTargets = request.delivery.outputs.flatMap(spec => spec.audio?.integratedLufs !== undefined || spec.audio?.maxTruePeakDbtp !== undefined ? [spec.audio] : []);
    requireCondition(new Set(audioTargets.map(spec => `${spec.integratedLufs ?? ''}:${spec.maxTruePeakDbtp ?? ''}`)).size <= 1, 'AUDIO_TARGETS_DIVERGE', 'One editable sequence mix requires a consistent requested loudness/peak target across outputs.');
    if (p.ducking || audioTargets.length) {
      if (!analysis) analysis = add('speech.analyze', 'audio.analyze', {}, { assets: { source: source(audioKey) }, depends: inspectKeys });
      const desired = audioTargets[0];
      finalSteps = [add('timeline.audio-mix', 'pr.audio.mix', { audioInput: audioKey, assemblyStepKey: assembled, cutMapStepKey: cutMap, analysisStepKey: analysis, ...(transcript ? { transcriptStepKey: transcript } : {}), ...(p.ducking ? { ducking: p.ducking } : {}), ...(desired?.integratedLufs !== undefined ? { integratedLufs: desired.integratedLufs } : {}), ...(desired?.maxTruePeakDbtp !== undefined ? { maxTruePeakDbtp: desired.maxTruePeakDbtp } : {}) }, { target: sequenceTarget, group: gid, depends: [...finalSteps, analysis, ...(transcript ? [transcript] : [])] })];
    }
    if (interview) {
      const captionSettings = asObject(p.captions);
      captionsStep = add('captions.build', 'pr.captions.build', { settings: captionSettings, cutMapStepKey: cutMap, ...(transcript ? { transcriptStepKey: transcript } : {}) }, { depends: [cutMap, ...(transcript ? [transcript] : [])], ...(captionSettings.inputKey ? { assets: { source: source(String(captionSettings.inputKey)) } } : {}) });
      if (captionSettings.nativeEditable === true) finalSteps = [add('captions.apply', 'pr.captions.apply', { captionsStepKey: captionsStep, stylePresetId: captionSettings.stylePresetId!, nativeEditable: true }, { target: sequenceTarget, group: gid, depends: [...finalSteps, captionsStep] })];
      else requireCondition(!request.delivery.preserveNativeEditing && request.delivery.allowedFallbacks.includes('rendered_asset'), 'CAPTION_FALLBACK_NOT_AUTHORIZED', 'Rendered captions require explicit native-preservation relaxation and rendered_asset fallback.');
    }
    finishVideo(target(project, 'project'), sequenceTarget, gid, finalSteps, captionsStep, interview && asObject(p.captions).nativeEditable === false);
  } else {
    const cross = request.recipeId === 'cross.ps_title_to_premiere.v1'; const gid = group('project', 'premiere', 'project', 'project');
    const project = add('project.open', 'pr.project.open', {}, { assets: { source: source('project') }, group: gid });
    const inspected = add('project.inspect', 'pr.timeline.inspect', {}, { target: target(project, 'project'), group: gid });
    const requirements: { role: string; ownerInputKey: string; kind: string; layerKind?: string }[] = [{ role: String(p.targetSequenceRole), ownerInputKey: 'project', kind: 'pr_sequence' }];
    const owners = [{ inputKey: 'project', inspectStepKey: inspected }]; let psDoc: TargetBinding | undefined; let psGroup: string | undefined;
    if (cross) {
      psGroup = group('title', 'photoshop', 'titleMaster', 'document');
      const opened = add('title.open', 'ps.document.open', {}, { assets: { source: source('titleMaster') }, group: psGroup }); psDoc = target(opened, 'document');
      const inspectedTitle = add('title.inspect', 'ps.document.inspect', {}, { target: psDoc, group: psGroup }); owners.push({ inputKey: 'titleMaster', inspectStepKey: inspectedTitle });
      for (const role of Object.keys(asObject(p.textByRole))) requirements.push({ role, ownerInputKey: 'titleMaster', kind: 'ps_layer', layerKind: 'text' });
      for (const role of Object.keys(asObject(p.imageByRole))) requirements.push({ role, ownerInputKey: 'titleMaster', kind: 'ps_layer' });
      requirements.push({ role: String(p.targetClipRole), ownerInputKey: 'project', kind: 'pr_clip' });
    } else for (const raw of p.changes as Params[]) {
      for (const key of ['targetRole', 'leftRole', 'rightRole']) if (raw[key]) requirements.push({ role: String(raw[key]), ownerInputKey: 'project', kind: 'pr_clip' });
      if (raw.targetTrackRole) requirements.push({ role: String(raw.targetTrackRole), ownerInputKey: 'project', kind: 'pr_track' });
    }
    const roleStep = roles('project.roles', owners, [...new Map(requirements.map(item => [item.role, item])).values()]); const sequenceTarget = target(roleStep, `role:${String(p.targetSequenceRole)}`); let previous = [roleStep];
    if (cross) {
      for (const [role, text] of Object.entries(asObject(p.textByRole))) previous = [add(`title.text.${role}`, 'ps.text.set', { text }, { target: target(roleStep, `role:${role}`), group: psGroup!, depends: previous })];
      for (const [role, key] of Object.entries(asObject(p.imageByRole))) previous = [add(`title.image.${role}`, 'ps.placeholder.replace', { fit: 'contain', roleStepKey: roleStep, role }, { target: target(roleStep, `role:${role}`), assets: { source: source(String(key)) }, group: psGroup!, depends: previous })];
      const titleOutputs = request.delivery.outputs.filter(spec => ['psd', 'psb', 'png'].includes(spec.format.toLowerCase())); psExport('title', psDoc!, psGroup!, titleOutputs, previous);
      const png = titleOutputs.find(spec => spec.format.toLowerCase() === 'png')!; const pngStep = `title.output.${png.outputKey}`;
      previous = [add('title.replaceInstance', 'pr.clip.replaceSource', { preserveAnimation: p.preserveAnimation!, preserveSourceRange: true, replacementScope: 'selected_instance' }, { target: target(roleStep, `role:${String(p.targetClipRole)}`), assets: { source: output(pngStep) }, group: gid, depends: [pngStep] })];
      const placement = asObject(p.timelinePlacement);
      previous = [add('title.place', 'pr.clip.move', { timelineStartTicks: frameTicks(String(placement.startFrame), placement.frameRate as unknown as { num: number; den: number }), collision: 'reject', linkedPolicy: 'preserve' }, { target: target(roleStep, `role:${String(p.targetClipRole)}`), group: gid, depends: previous })];
      previous = [add('title.duration', 'pr.clip.duration', { durationTicks: frameTicks(String(placement.durationFrames), placement.frameRate as unknown as { num: number; den: number }), linkedPolicy: 'preserve' }, { target: target(roleStep, `role:${String(p.targetClipRole)}`), group: gid, depends: previous })];
    } else for (const change of p.changes as Params[]) {
      const key = `change.${change.changeKey}`; const exactTarget = target(roleStep, `role:${String(change.targetRole ?? change.leftRole)}`); const rate = p.frameRate as unknown as { num: number; den: number }; let operation: string; let args: JsonObject; let assets: Record<string, AssetBinding> | undefined;
      switch (change.kind) {
        case 'clip_move': operation = 'pr.clip.move'; args = { timelineStartTicks: frameTicks(String(change.timelineStartFrame), rate), collision: change.collision!, linkedPolicy: change.linkedPolicy!, ...(change.targetTrackRole ? { targetTrackRole: change.targetTrackRole, roleStepKey: roleStep } : {}) }; break;
        case 'clip_trim': operation = 'pr.clip.trim'; args = { ...(change.sourceInTicks !== undefined ? { sourceInTicks: change.sourceInTicks } : {}), ...(change.sourceOutTicks !== undefined ? { sourceOutTicks: change.sourceOutTicks } : {}), anchor: change.anchor!, linkedPolicy: change.linkedPolicy! }; break;
        case 'clip_remove': operation = 'pr.clip.remove'; args = { ripple: change.ripple!, linkedPolicy: change.linkedPolicy! }; break;
        case 'clip_replace_media': operation = 'pr.clip.replaceSource'; args = { preserveAnimation: change.preserveAnimation!, preserveSourceRange: change.preserveSourceRange!, replacementScope: 'selected_instance' }; assets = { source: source(String(change.inputKey)) }; break;
        case 'title_text': operation = 'pr.title.setText'; args = { text: change.text!, preserveAnimation: change.preserveAnimation! }; break;
        case 'audio_gain': operation = 'pr.audio.gain'; args = { db: change.gainDb! }; break;
        case 'effect_set': operation = 'pr.effect.apply'; args = { effect: change.effect!, existingEffectPolicy: change.existingEffectPolicy! }; break;
        case 'motion': operation = 'pr.motion.set'; args = { property: change.property!, mode: change.mode!, ...(change.value !== undefined ? { value: change.value } : {}), ...(change.keyframes ? { keyframes: (change.keyframes as Params[]).map(item => ({ ticks: frameTicks(String(item.frame), rate), value: item.value!, interpolation: item.interpolation! })) } : {}) }; break;
        case 'transition': operation = 'pr.transition.apply'; args = { rightRole: change.rightRole!, transition: change.transition!, durationTicks: frameTicks(String(change.durationFrames), rate), insufficientHandles: change.insufficientHandles! }; break;
        default: throw new Error(`Unregistered revision change ${String(change.kind)}`);
      }
      previous = [add(key, operation, args, { target: exactTarget, group: gid, depends: previous, ...(assets ? { assets } : {}) })];
    }
    finishVideo(target(project, 'project'), sequenceTarget, gid, previous);
  }
  validateDag(steps);
  return { contractVersion: '1.0', requestId: request.requestId, workflowHome: request.workflowHome, jobId, revisionId, brief: request.brief, inputs: request.inputs, steps, materializationGroups: groups, delivery: request.delivery, resources: request.resources, review: request.review, controller: request.controller, ...(request.revisionOf ? { parentRevisionId: request.revisionOf.revisionId } : {}) };
}
