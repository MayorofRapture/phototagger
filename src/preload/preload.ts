import { contextBridge } from 'electron';
import { photoTaggerApi } from './api';

contextBridge.exposeInMainWorld('photoTagger', photoTaggerApi);
