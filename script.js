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

            let isResourcePack = false;
            if (manifest.modules && Array.isArray(manifest.modules)) {
                isResourcePack = manifest.modules.some(mod => mod.type === "resources");
            }

            // Update header.min_engine_version
            if (manifest.header) {
                if (isResourcePack) {
                    // [終極解法] Tynker 的資源包 (Resource Pack) 充滿了舊版 1.8.0 的模型與渲染語法。
                    // 如果我們把資源包的引擎版本升級到 1.21+，Minecraft 會啟動「嚴格模式」並徹底禁用舊版渲染，導致自訂模型完全失效。
                    // 將資源包設定為 1.16.0，既能被新版教育版接受，又能觸發 Minecraft 的「舊版寬容解析器」，自動包容 Tynker 產生的錯誤模型！
                    manifest.header.min_engine_version = [1, 16, 0];
                } else {
                    // 行為包 (Behavior Pack) 必須升級到最新版，才能正確覆寫原版生物的 AI 與行為。
                    manifest.header.min_engine_version = targetVersionArray;
                }
                modified = true;
            }
            
            // Modern Bedrock requires manifest format_version to be 2
            if (manifest.format_version !== 2) {
                manifest.format_version = 2;
                modified = true;
            }
            
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

            // 1. Behavior Pack Entity Fixes
            if (data["minecraft:entity"]) {
                if (data["minecraft:entity"]["format_version"]) {
                    data["format_version"] = versionStr;
                    delete data["minecraft:entity"]["format_version"];
                    modified = true;
                }

                if (data["format_version"]) {
                    const fv = data["format_version"];
                    const parts = fv.split('.').map(Number);
                    if (parts.length >= 2 && (parts[0] < 1 || (parts[0] === 1 && parts[1] < 16))) {
                        data["format_version"] = versionStr;
                        modified = true;
                    }
                }
            }

            // 2. Client Entity Fixes
            // 確保 client_entity 至少為 1.10.0，避免在某些版本中舊版設定被捨棄
            if (data["minecraft:client_entity"]) {
                if (!data["format_version"] || data["format_version"] === "1.8.0") {
                    data["format_version"] = "1.10.0"; 
                    modified = true;
                }
            }

            // 3. Migrate legacy 1.8.0 geometries to modern 1.12.0 format
            const legacyGeometryKeys = Object.keys(data).filter(key => key.startsWith("geometry."));
            if (legacyGeometryKeys.length > 0) {
                const newGeometries = [];
                for (const geoKey of legacyGeometryKeys) {
                    const oldGeo = data[geoKey];
                    const description = { identifier: geoKey };
                    
                    description.texture_width = oldGeo.texturewidth || oldGeo.texture_width || 64;
                    description.texture_height = oldGeo.textureheight || oldGeo.texture_height || 64;
                    
                    if (oldGeo.visible_bounds_width !== undefined) description.visible_bounds_width = oldGeo.visible_bounds_width;
                    if (oldGeo.visible_bounds_height !== undefined) description.visible_bounds_height = oldGeo.visible_bounds_height;
                    if (oldGeo.visible_bounds_offset !== undefined) description.visible_bounds_offset = oldGeo.visible_bounds_offset;

                    newGeometries.push({
                        description: description,
                        bones: oldGeo.bones || []
                    });
                    delete data[geoKey]; 
                }
                
                data["minecraft:geometry"] = newGeometries;
                data["format_version"] = "1.12.0";
                modified = true;
            }

            // 4. Sanitize all geometries (Fix Tynker's Add Block bugs)
            if (Array.isArray(data["minecraft:geometry"])) {
                if (!data["format_version"]) {
                    data["format_version"] = "1.12.0";
                    modified = true;
                }
                
                data["minecraft:geometry"].forEach(geo => {
                    if (geo.description) {
                        if (geo.description.texture_width === undefined) geo.description.texture_width = 64;
                        if (geo.description.texture_height === undefined) geo.description.texture_height = 64;
                    }

                    if (Array.isArray(geo.bones)) {
                        geo.bones.forEach(bone => {
                            if (Array.isArray(bone.cubes)) {
                                bone.cubes.forEach(cube => {
                                    if (cube.uv === undefined) {
                                        cube.uv = [0, 0];
                                        modified = true;
                                    }
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
