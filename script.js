document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const convertBtn = document.getElementById('convert-btn');
    const targetVersionInput = document.getElementById('target-version');
    const statusMessage = document.getElementById('status-message');
    const dropZoneText = document.querySelector('.drop-zone-text');

    let selectedFile = null;

    // Drag and drop events
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.classList.add('dragover');
        }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.classList.remove('dragover');
        }, false);
    });

    dropZone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        handleFiles(files);
    });

    fileInput.addEventListener('change', function() {
        handleFiles(this.files);
    });

    function handleFiles(files) {
        if (files.length > 0) {
            const file = files[0];
            if (file.name.endsWith('.mcaddon') || file.name.endsWith('.zip') || file.name.endsWith('.mcpack')) {
                selectedFile = file;
                dropZoneText.textContent = `已選擇：${file.name}`;
                convertBtn.disabled = false;
                setStatus('');
            } else {
                selectedFile = null;
                dropZoneText.textContent = '不支援的檔案格式，請上傳 .mcaddon';
                convertBtn.disabled = true;
                setStatus('請選擇正確的 .mcaddon 檔案', 'error');
            }
        }
    }

    function setStatus(msg, type = '') {
        statusMessage.textContent = msg;
        statusMessage.className = 'status-message ' + type;
    }

    convertBtn.addEventListener('click', async () => {
        if (!selectedFile) return;

        const versionStr = targetVersionInput.value.trim();
        const versionMatch = versionStr.match(/^(\d+)\.(\d+)\.(\d+)$/);
        
        if (!versionMatch) {
            setStatus('版本格式錯誤！應為如 1.19.52', 'error');
            return;
        }

        const targetVersionArray = [
            parseInt(versionMatch[1], 10),
            parseInt(versionMatch[2], 10),
            parseInt(versionMatch[3], 10)
        ];

        try {
            convertBtn.disabled = true;
            setStatus('處理中...請稍候', 'loading');

            const buffer = await selectedFile.arrayBuffer();
            const zip = new JSZip();
            const loadedZip = await zip.loadAsync(buffer);

            let manifestFound = false;

            // Recursive function to process zip and nested zips
            async function processZip(currentZip) {
                const promises = [];
                currentZip.forEach((relativePath, zipEntry) => {
                    if (!zipEntry.dir) {
                        if (relativePath.endsWith('manifest.json')) {
                            manifestFound = true;
                            const p = zipEntry.async("string").then(content => {
                                const updatedContent = updateManifest(content, targetVersionArray);
                                currentZip.file(relativePath, updatedContent);
                            });
                            promises.push(p);
                        } else if (relativePath.endsWith('.mcpack') || relativePath.endsWith('.zip')) {
                            const p = zipEntry.async("arraybuffer").then(async nestedBuffer => {
                                const nestedZip = new JSZip();
                                const loadedNestedZip = await nestedZip.loadAsync(nestedBuffer);
                                await processZip(loadedNestedZip); // Recursive call
                                const newNestedBuffer = await loadedNestedZip.generateAsync({type: "arraybuffer"});
                                currentZip.file(relativePath, newNestedBuffer);
                            });
                            promises.push(p);
                        } else if (relativePath.endsWith('.json')) {
                            // Fix Tynker's broken entity JSON formatting
                            const p = zipEntry.async("string").then(content => {
                                const updatedContent = fixTynkerEntityFormat(content, versionStr);
                                currentZip.file(relativePath, updatedContent);
                            });
                            promises.push(p);
                        }
                    }
                });
                await Promise.all(promises);
            }

            await processZip(loadedZip);

            if (!manifestFound) {
                setStatus('在檔案中找不到任何 manifest.json！', 'error');
                convertBtn.disabled = false;
                return;
            }

            setStatus('打包中...', 'loading');
            const blob = await loadedZip.generateAsync({
                type: "blob",
                compression: "DEFLATE",
                compressionOptions: { level: 6 }
            });

            // Trigger download
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            
            // Output file name based on input
            let newName = selectedFile.name;
            if (newName.endsWith('.mcaddon')) {
                newName = newName.replace('.mcaddon', `_v${versionStr}.mcaddon`);
            } else if (newName.endsWith('.zip')) {
                newName = newName.replace('.zip', `_v${versionStr}.mcaddon`);
            } else if (newName.endsWith('.mcpack')) {
                newName = newName.replace('.mcpack', `_v${versionStr}.mcpack`);
            } else {
                newName += `_v${versionStr}.mcaddon`;
            }
            
            a.download = newName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            setStatus('轉換並下載成功！', 'success');
        } catch (error) {
            console.error(error);
            setStatus(`發生錯誤：${error.message}`, 'error');
        } finally {
            convertBtn.disabled = false;
        }
    });

    function updateManifest(manifestStr, targetVersionArray) {
        try {
            let manifest = JSON.parse(manifestStr);
            let modified = false;

            // Update header.min_engine_version
            if (manifest.header) {
                manifest.header.min_engine_version = targetVersionArray;
                modified = true;
            }
            
            // Modern Bedrock requires manifest format_version to be 2
            if (manifest.format_version !== 2) {
                manifest.format_version = 2;
                modified = true;
            }
            
            // Note: We avoid changing module versions or UUIDs, to minimize the chance of breaking the addon.
            // min_engine_version is the most critical field for Minecraft Education compatibility.

            return modified ? JSON.stringify(manifest, null, 2) : manifestStr;
        } catch (e) {
            console.error("解析 manifest.json 失敗", e);
            return manifestStr;
        }
    }

    function fixTynkerEntityFormat(jsonStr, versionStr) {
        try {
            let data = JSON.parse(jsonStr);
            let modified = false;

            // Only apply format_version fixes to behavior pack entities.
            // DO NOT touch geometry, animations, or client_entity files, as their schema strictly depends on format_version.
            if (data["minecraft:entity"]) {
                // Tynker bug: format_version is placed inside minecraft:entity instead of root
                if (data["minecraft:entity"]["format_version"]) {
                    data["format_version"] = versionStr;
                    delete data["minecraft:entity"]["format_version"];
                    modified = true;
                }

                // If it's a behavior entity override and uses an old format, update it to the target version
                // so Minecraft doesn't reject it as a legacy override
                if (data["format_version"]) {
                    const fv = data["format_version"];
                    const parts = fv.split('.').map(Number);
                    // Properly compare versions (e.g. 1.8.0 vs 1.16.0)
                    if (parts.length >= 2 && (parts[0] < 1 || (parts[0] === 1 && parts[1] < 16))) {
                        data["format_version"] = versionStr;
                        modified = true;
                    }
                }
            }

            // 2. Migrate legacy 1.8.0 geometries to modern 1.12.0 format
            const legacyGeometryKeys = Object.keys(data).filter(key => key.startsWith("geometry."));
            if (legacyGeometryKeys.length > 0) {
                const newGeometries = [];
                for (const geoKey of legacyGeometryKeys) {
                    const oldGeo = data[geoKey];
                    const description = {
                        identifier: geoKey
                    };
                    
                    // Map legacy texture dimensions safely
                    description.texture_width = oldGeo.texturewidth || oldGeo.texture_width || 64;
                    description.texture_height = oldGeo.textureheight || oldGeo.texture_height || 64;
                    
                    // Map visible bounds
                    if (oldGeo.visible_bounds_width !== undefined) description.visible_bounds_width = oldGeo.visible_bounds_width;
                    if (oldGeo.visible_bounds_height !== undefined) description.visible_bounds_height = oldGeo.visible_bounds_height;
                    if (oldGeo.visible_bounds_offset !== undefined) description.visible_bounds_offset = oldGeo.visible_bounds_offset;

                    const newGeo = {
                        description: description,
                        bones: oldGeo.bones || []
                    };
                    
                    newGeometries.push(newGeo);
                    delete data[geoKey]; // Remove the old legacy geometry key
                }
                
                data["minecraft:geometry"] = newGeometries;
                data["format_version"] = "1.12.0";
                modified = true;
            }

            // 3. Sanitize all geometries (modern or newly migrated) for strict 1.21+ validation
            if (Array.isArray(data["minecraft:geometry"])) {
                data["minecraft:geometry"].forEach(geo => {
                    // Ensure texture dimensions exist
                    if (geo.description) {
                        if (geo.description.texture_width === undefined) geo.description.texture_width = 64;
                        if (geo.description.texture_height === undefined) geo.description.texture_height = 64;
                    }

                    if (Array.isArray(geo.bones)) {
                        geo.bones.forEach(bone => {
                            if (Array.isArray(bone.cubes)) {
                                bone.cubes.forEach(cube => {
                                    // Fix missing uv (Tynker bug when adding new blocks)
                                    if (cube.uv === undefined) {
                                        cube.uv = [0, 0];
                                        modified = true;
                                    }
                                    // Fix negative sizes (Tynker bug when dragging blocks inversely)
                                    // Minecraft 1.21 strictly rejects geometries with negative sizes
                                    if (Array.isArray(cube.size)) {
                                        for (let i = 0; i < 3; i++) {
                                            if (cube.size[i] < 0) {
                                                if (Array.isArray(cube.origin)) {
                                                    cube.origin[i] += cube.size[i];
                                                }
                                                cube.size[i] = Math.abs(cube.size[i]);
                                                modified = true;
                                            }
                                        }
                                    }
                                });
                            }
                        });
                    }
                });
            }

            return modified ? JSON.stringify(data, null, 2) : jsonStr;
        } catch (e) {
            // Ignore non-JSON or malformed files
            return jsonStr;
        }
    }
});
