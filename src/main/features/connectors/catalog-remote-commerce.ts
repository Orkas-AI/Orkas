/** Commerce connectors backed by provider-hosted remote MCP servers.
 *
 * These entries do not use Composio and do not require an Orkas-owned OAuth application. The
 * provider runs OAuth + DCR; Orkas pins the endpoint, requested business scopes, and reviewed MCP
 * action names so upstream catalog growth cannot silently widen the agent's authority.
 */
import type { CatalogEntry, ConnectorActionPolicy } from './types';

// Source artwork is the provider logo asset mirrored by Composio's public logo service. Only the
// XML/DOCTYPE wrapper and fixed 128 px dimensions were removed; path and brand colour data are
// unchanged. The catalog test pins the resulting bytes to prevent accidental redraws.
const KLAVIYO_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0.00 0.00 512.00 512.00" width="100%" height="100%"><path stroke="#919293" stroke-width="2.00" fill="none" stroke-linecap="butt" vector-effect="non-scaling-stroke" d="M 99.95 256.02 Q 99.95 353.16 99.98 361.45 A 0.60 0.59 -0.3 0 0 100.58 362.04 L 417.40 362.04 A 0.36 0.36 0.0 0 0 417.71 361.49 Q 392.28 321.21 351.41 256.24 Q 351.37 256.19 351.37 256.01 Q 351.37 255.84 351.41 255.79 Q 392.28 190.82 417.71 150.54 A 0.36 0.36 0.0 0 0 417.40 149.99 L 100.58 149.99 A 0.60 0.59 0.3 0 0 99.98 150.58 Q 99.95 158.88 99.95 256.02" /><path fill="#ffffff" d="M 264.22 0.00 Q 337.49 3.46 394.98 40.97 Q 446.26 74.43 477.15 126.95 Q 508.98 181.05 512.00 247.71 L 512.00 264.18 C 509.45 333.16 479.65 398.60 429.27 444.51 Q 359.89 507.74 264.29 512.00 L 247.90 512.00 Q 174.46 508.56 116.88 470.94 Q 65.62 437.44 34.76 384.89 Q 2.98 330.79 0.00 264.16 L 0.00 247.68 C 3.14 164.46 45.21 88.80 114.52 42.66 Q 173.78 3.22 247.62 0.00 L 264.22 0.00 Z M 99.95 256.02 Q 99.95 353.16 99.98 361.45 A 0.60 0.59 -0.3 0 0 100.58 362.04 L 417.40 362.04 A 0.36 0.36 0.0 0 0 417.71 361.49 Q 392.28 321.21 351.41 256.24 Q 351.37 256.19 351.37 256.01 Q 351.37 255.84 351.41 255.79 Q 392.28 190.82 417.71 150.54 A 0.36 0.36 0.0 0 0 417.40 149.99 L 100.58 149.99 A 0.60 0.59 0.3 0 0 99.98 150.58 Q 99.95 158.88 99.95 256.02 Z" /><path fill="#232426" d="M 351.37 256.01 Q 351.37 256.19 351.41 256.24 Q 392.28 321.21 417.71 361.49 A 0.36 0.36 0.0 0 1 417.40 362.04 L 100.58 362.04 A 0.60 0.59 -0.3 0 1 99.98 361.45 Q 99.95 353.16 99.95 256.02 Q 99.95 158.88 99.98 150.58 A 0.60 0.59 0.3 0 1 100.58 149.99 L 417.40 149.99 A 0.36 0.36 0.0 0 1 417.71 150.54 Q 392.28 190.82 351.41 255.79 Q 351.37 255.84 351.37 256.01 Z" /></svg>';
const PAYPAL_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0.00 0.00 258.00 258.00" width="100%" height="100%"><g stroke-width="2.00" fill="none" stroke-linecap="butt"><path stroke="#005bc8" vector-effect="non-scaling-stroke" d="M 194.98 81.98 Q 183.14 76.05 171.50 76.01 Q 142.87 75.94 114.32 76.00 A 0.35 0.34 2.9 0 0 113.99 76.29 L 104.66 135.64" /><path stroke="#307bc8" vector-effect="non-scaling-stroke" d="M 104.66 135.64 L 95.30 195.23" /><path stroke="#30adff" vector-effect="non-scaling-stroke" d="M 195.29 82.21 Q 194.79 82.67 194.90 82.84 Q 195.02 83.01 195.01 83.04 Q 193.23 104.81 177.31 119.83 Q 165.90 130.60 151.14 134.17 Q 145.18 135.61 129.73 135.62 Q 117.24 135.63 104.66 135.64" /></g><path fill="#002991" d="M 194.98 81.98 Q 183.14 76.05 171.50 76.01 Q 142.87 75.94 114.32 76.00 A 0.35 0.34 2.9 0 0 113.99 76.29 L 104.66 135.64 L 95.30 195.23 L 54.48 195.23 A 0.27 0.26 -85.4 0 1 54.22 194.92 L 78.83 36.81 A 0.64 0.63 4.2 0 1 79.46 36.27 Q 135.96 36.19 147.45 36.32 C 160.74 36.47 173.96 41.93 183.13 51.62 Q 194.65 63.77 194.98 81.98 Z" /><path fill="#008cff" d="M 194.98 81.98 Q 195.24 82.39 195.29 82.21 Q 194.79 82.67 194.90 82.84 Q 195.02 83.01 195.01 83.04 Q 193.23 104.81 177.31 119.83 Q 165.90 130.60 151.14 134.17 Q 145.18 135.61 129.73 135.62 Q 117.24 135.63 104.66 135.64 L 113.99 76.29 A 0.35 0.34 2.9 0 1 114.32 76.00 Q 142.87 75.94 171.50 76.01 Q 183.14 76.05 194.98 81.98 Z" /><path fill="#60cdff" d="M 195.29 82.21 C 214.11 92.01 222.58 111.83 217.64 132.36 C 212.19 154.99 192.61 171.81 169.86 174.87 C 161.49 175.99 148.30 175.29 139.78 175.39 A 0.79 0.78 -85.2 0 0 139.01 176.05 L 129.91 234.55 A 0.53 0.53 0.0 0 1 129.39 235.00 L 89.30 235.00 A 0.48 0.47 4.6 0 1 88.83 234.45 L 95.30 195.23 L 104.66 135.64 Q 117.24 135.63 129.73 135.62 Q 145.18 135.61 151.14 134.17 Q 165.90 130.60 177.31 119.83 Q 193.23 104.81 195.01 83.04 Q 195.02 83.01 194.90 82.84 Q 194.79 82.67 195.29 82.21 Z" /></svg>';

const NETSUITE_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0.00 0.00 256.00 256.00" width="100%" height="100%"><g stroke-width="2.00" fill="none" stroke-linecap="butt"><path stroke="#0c1720" vector-effect="non-scaling-stroke" d=" M 73.69 171.22 C 79.61 168.02 83.73 170.92 88.39 174.07 C 96.74 179.71 110.57 179.63 119.43 175.96 C 122.04 174.89 124.48 173.12 127.52 173.29 Q 130.23 173.44 133.61 175.48 A 3.87 3.80 68.2 0 0 134.52 175.88 Q 139.52 177.31 145.58 179.66 C 151.11 181.81 155.52 182.23 161.75 182.19 C 169.44 182.14 175.19 182.28 180.51 179.42 Q 182.59 178.31 185.19 177.39 Q 202.72 171.16 212.71 154.73 C 215.59 150.00 219.35 143.73 219.37 138.81 Q 219.39 128.87 219.37 118.93 Q 219.35 112.82 217.79 109.94 C 214.96 104.73 213.50 101.02 210.29 96.97 Q 204.33 89.43 199.69 86.39 Q 191.47 81.01 179.02 76.56 Q 172.33 74.17 162.25 75.87 A 1.38 1.37 -75.8 0 0 161.39 76.39 L 158.74 79.84 A 1.06 0.85 -85.1 0 1 158.56 80.03 Q 150.53 87.03 149.50 88.26 Q 144.31 94.42 137.18 102.68 Q 134.62 105.64 131.21 107.93 A 0.87 0.87 0.0 0 1 130.03 107.74 Q 122.90 98.44 114.03 89.80 Q 109.58 85.47 102.83 81.87 Q 101.02 80.91 99.18 80.36 C 95.63 79.30 94.42 79.02 90.26 77.55 C 81.14 74.35 73.65 78.06 65.03 81.03 A 16.00 15.88 19.3 0 0 61.86 82.54 Q 58.55 84.59 57.26 85.52 Q 52.69 88.81 44.65 97.67 A 9.00 8.80 78.0 0 0 43.00 100.27 Q 41.54 103.84 40.14 105.86 C 37.62 109.52 37.34 113.11 37.24 117.02 Q 37.08 123.17 37.35 130.78 Q 37.49 134.58 38.80 137.34 Q 42.95 146.05 45.14 149.13 Q 52.08 158.91 65.36 168.48 Q 69.72 171.63 72.63 171.51 A 2.45 2.37 -59.4 0 0 73.69 171.22" /><path stroke="#6b7a83" vector-effect="non-scaling-stroke" d=" M 60.30 139.91 Q 57.80 132.04 61.09 125.41 Q 63.20 121.18 66.64 117.88 Q 68.99 115.62 72.62 115.78" /><path stroke="#798388" vector-effect="non-scaling-stroke" d=" M 72.62 115.78 C 78.70 116.65 84.52 122.86 88.08 127.60 C 94.33 135.90 102.35 144.74 111.34 151.01 C 114.74 153.38 117.05 156.57 120.60 158.79 Q 126.19 162.27 132.21 165.81 C 136.33 168.23 140.03 168.97 144.51 170.73 C 153.17 174.14 163.31 174.55 172.48 173.46 C 177.80 172.82 182.38 170.54 186.12 169.03 C 192.85 166.32 199.47 160.92 203.05 155.80 C 207.61 149.29 210.46 144.40 211.49 137.00 Q 212.86 127.06 211.49 116.99 Q 210.65 110.82 207.26 105.40 C 199.77 93.42 186.82 85.09 173.26 82.77 Q 167.42 81.78 162.82 83.46 C 159.91 84.52 156.39 88.20 154.36 89.86 A 1.25 1.25 0.0 0 0 154.42 91.84 Q 155.98 92.97 157.75 91.90 C 163.95 88.13 173.22 88.87 179.50 93.00 Q 186.95 97.90 188.61 99.66 Q 192.95 104.24 194.03 106.79 Q 195.26 109.68 198.03 119.08 A 3.69 3.63 36.4 0 1 198.19 120.08 Q 198.33 125.63 196.11 132.01 C 194.15 137.64 184.91 146.74 179.34 147.38 Q 162.30 149.35 148.36 139.33 C 143.44 135.80 138.30 131.62 134.79 126.40 C 131.86 122.04 128.21 118.90 125.72 114.65 Q 124.32 112.26 118.56 104.49 Q 110.99 94.29 101.44 89.34 Q 100.48 88.84 91.96 85.76 C 88.62 84.54 81.89 83.84 79.39 84.41 C 64.82 87.72 53.20 94.88 47.07 108.81 Q 46.18 110.83 45.91 113.49 Q 45.05 122.25 45.83 131.01 C 46.01 133.02 46.71 136.29 47.67 138.28 Q 54.74 152.95 68.64 162.36 Q 72.01 164.65 75.53 165.56 A 1.64 1.64 0.0 0 0 77.54 163.64 Q 77.53 163.60 77.14 162.96 Q 76.79 162.37 76.62 162.25 C 73.90 160.27 72.51 157.33 70.25 154.77 Q 64.10 147.80 63.45 146.31 Q 61.96 142.89 60.30 139.91" /><path stroke="#deeff6" vector-effect="non-scaling-stroke" d=" M 72.62 115.78 C 69.80 113.05 70.04 110.17 73.56 108.30 A 1.13 1.12 46.2 0 1 74.67 108.33 Q 83.30 113.38 88.44 118.56 Q 101.54 131.78 112.93 142.08 Q 122.33 150.58 128.91 154.61 C 138.18 160.31 149.60 165.19 160.56 164.50 Q 171.55 163.81 176.72 164.12 A 0.38 0.38 0.0 0 0 177.10 163.61 C 175.35 158.92 171.06 157.08 166.49 155.93 Q 146.02 150.79 132.33 134.42 Q 128.15 129.43 124.62 124.60 C 119.42 117.49 114.28 111.50 108.26 104.50 Q 102.97 98.33 95.71 95.36 Q 88.31 92.33 85.64 92.21 Q 69.36 91.43 59.23 104.67 C 54.82 110.42 54.86 114.58 55.39 122.35 Q 56.01 131.66 60.30 139.91" /><path stroke="#56737f" vector-effect="non-scaling-stroke" d=" M 156.72 116.12 Q 158.71 115.02 160.56 114.65 A 1.99 1.99 0.0 0 0 161.44 114.25 C 165.88 110.74 173.15 110.78 178.01 112.16 A 4.00 3.94 -18.9 0 1 179.26 112.76 Q 181.62 114.45 183.62 115.34 C 186.73 116.71 187.71 118.07 189.72 120.99 C 190.75 122.49 192.23 123.68 193.93 123.85 A 1.51 1.50 6.4 0 0 195.56 122.55 C 195.94 119.63 195.04 116.80 193.36 114.11 Q 190.86 110.13 189.01 106.67 A 3.03 2.94 4.6 0 0 188.14 105.68 Q 185.73 103.98 183.42 101.13 A 6.02 5.92 -2.0 0 0 182.09 99.91 L 174.29 94.67 A 1.39 1.18 63.6 0 0 173.87 94.49 Q 167.23 93.07 159.25 93.98 C 155.01 94.47 151.38 97.82 147.50 101.15 C 143.16 104.87 140.23 109.48 135.07 116.08 Q 133.71 117.81 134.65 119.43 Q 136.60 122.81 139.57 125.21 A 2.68 2.67 46.9 0 0 142.79 125.32 L 149.43 120.65 A 0.43 0.32 8.0 0 1 149.52 120.60 Q 152.72 118.93 154.01 117.79 Q 154.49 117.36 156.72 116.12" /><path stroke="#827a45" vector-effect="non-scaling-stroke" d=" M 180.00 117.29 C 178.77 114.41 173.05 114.66 170.65 115.34 Q 161.23 117.98 153.41 123.34 A 5.57 5.14 -71.3 0 1 152.51 123.83 Q 148.67 125.41 145.10 128.02 A 1.82 1.82 0.0 0 0 144.78 130.66 Q 148.97 135.68 153.80 137.64 A 3.14 3.13 33.0 0 0 157.24 136.91 C 160.63 133.38 165.44 128.27 170.47 125.41 Q 174.16 123.31 179.13 119.97 A 2.28 2.15 -28.8 0 0 180.00 117.29" /><path stroke="#56737f" vector-effect="non-scaling-stroke" d=" M 70.55 124.05 Q 68.84 121.92 66.18 123.93 C 61.30 127.61 61.34 131.74 63.98 137.31 Q 67.05 143.76 67.85 144.88 Q 69.96 147.87 76.80 156.49 A 18.38 18.14 0.5 0 0 79.77 159.47 C 84.82 163.46 87.37 165.84 90.97 167.48 Q 94.80 169.24 104.92 171.64 C 109.19 172.65 116.71 170.49 120.40 169.15 C 122.09 168.54 123.44 166.90 122.09 165.25 Q 117.95 160.19 111.51 159.89 Q 105.08 159.59 101.80 159.59 Q 100.34 159.59 90.35 156.16 A 3.87 3.86 73.0 0 1 89.28 155.59 L 80.81 149.10 A 3.74 3.66 3.2 0 1 79.97 148.18 Q 77.91 145.04 74.80 140.76 Q 71.33 135.97 70.76 132.96 Q 70.59 132.10 70.64 129.43 A 2.49 2.28 -37.2 0 1 70.77 128.72 Q 71.50 126.63 70.98 124.87 A 2.38 2.28 18.6 0 0 70.55 124.05" /><path stroke="#7d6836" vector-effect="non-scaling-stroke" d=" M 79.84 137.88 L 79.37 139.36 A 1.36 1.36 0.0 0 0 79.50 140.46 Q 87.49 153.60 102.75 155.31 Q 103.64 155.41 104.10 155.08 A 1.00 0.97 54.3 0 0 104.31 153.68 Q 102.39 151.11 100.16 148.85 C 97.51 146.15 93.99 144.65 90.84 143.23 C 87.32 141.64 84.34 139.24 81.72 137.28 A 1.21 1.21 0.0 0 0 79.84 137.88" /></g><path fill="#12202b" d=" M 143.88 1.86 Q 144.70 1.98 152.19 3.67 C 158.30 5.05 164.37 7.38 169.11 8.72 Q 173.95 10.09 177.73 11.72 Q 199.02 20.94 215.23 36.08 Q 232.00 51.76 242.90 73.47 Q 245.13 77.91 247.03 83.33 Q 250.49 93.24 250.54 93.43 Q 254.35 106.48 255.05 116.75 Q 255.25 119.71 255.33 133.25 Q 255.40 144.56 253.75 150.99 C 252.83 154.59 251.42 161.85 249.51 166.98 C 247.16 173.30 245.99 178.14 242.99 183.75 Q 236.92 195.12 233.10 200.62 Q 217.74 222.70 195.28 236.53 C 191.06 239.13 183.85 243.23 178.61 245.34 Q 165.10 250.75 152.46 253.26 C 141.37 255.46 130.21 255.59 119.75 255.17 Q 111.14 254.82 102.03 252.72 Q 85.14 248.83 71.83 241.96 Q 37.15 224.05 18.56 191.26 Q 17.68 189.72 14.49 183.83 Q 12.63 180.40 11.03 176.03 Q 4.63 158.56 1.30 141.00 Q 0.09 134.67 0.85 121.54 Q 1.32 113.51 4.40 102.40 Q 9.08 85.49 12.59 77.53 Q 16.73 68.14 24.61 56.53 Q 35.03 41.16 50.64 28.85 Q 58.63 22.55 69.45 16.68 Q 78.24 11.91 84.04 10.03 Q 97.80 5.55 103.38 4.17 Q 115.41 1.19 123.27 0.82 Q 133.42 0.34 143.88 1.86 Z M 73.69 171.22 C 79.61 168.02 83.73 170.92 88.39 174.07 C 96.74 179.71 110.57 179.63 119.43 175.96 C 122.04 174.89 124.48 173.12 127.52 173.29 Q 130.23 173.44 133.61 175.48 A 3.87 3.80 68.2 0 0 134.52 175.88 Q 139.52 177.31 145.58 179.66 C 151.11 181.81 155.52 182.23 161.75 182.19 C 169.44 182.14 175.19 182.28 180.51 179.42 Q 182.59 178.31 185.19 177.39 Q 202.72 171.16 212.71 154.73 C 215.59 150.00 219.35 143.73 219.37 138.81 Q 219.39 128.87 219.37 118.93 Q 219.35 112.82 217.79 109.94 C 214.96 104.73 213.50 101.02 210.29 96.97 Q 204.33 89.43 199.69 86.39 Q 191.47 81.01 179.02 76.56 Q 172.33 74.17 162.25 75.87 A 1.38 1.37 -75.8 0 0 161.39 76.39 L 158.74 79.84 A 1.06 0.85 -85.1 0 1 158.56 80.03 Q 150.53 87.03 149.50 88.26 Q 144.31 94.42 137.18 102.68 Q 134.62 105.64 131.21 107.93 A 0.87 0.87 0.0 0 1 130.03 107.74 Q 122.90 98.44 114.03 89.80 Q 109.58 85.47 102.83 81.87 Q 101.02 80.91 99.18 80.36 C 95.63 79.30 94.42 79.02 90.26 77.55 C 81.14 74.35 73.65 78.06 65.03 81.03 A 16.00 15.88 19.3 0 0 61.86 82.54 Q 58.55 84.59 57.26 85.52 Q 52.69 88.81 44.65 97.67 A 9.00 8.80 78.0 0 0 43.00 100.27 Q 41.54 103.84 40.14 105.86 C 37.62 109.52 37.34 113.11 37.24 117.02 Q 37.08 123.17 37.35 130.78 Q 37.49 134.58 38.80 137.34 Q 42.95 146.05 45.14 149.13 Q 52.08 158.91 65.36 168.48 Q 69.72 171.63 72.63 171.51 A 2.45 2.37 -59.4 0 0 73.69 171.22 Z" /><path fill="#050e15" d=" M 72.63 171.51 Q 69.72 171.63 65.36 168.48 Q 52.08 158.91 45.14 149.13 Q 42.95 146.05 38.80 137.34 Q 37.49 134.58 37.35 130.78 Q 37.08 123.17 37.24 117.02 C 37.34 113.11 37.62 109.52 40.14 105.86 Q 41.54 103.84 43.00 100.27 A 9.00 8.80 78.0 0 1 44.65 97.67 Q 52.69 88.81 57.26 85.52 Q 58.55 84.59 61.86 82.54 A 16.00 15.88 19.3 0 1 65.03 81.03 C 73.65 78.06 81.14 74.35 90.26 77.55 C 94.42 79.02 95.63 79.30 99.18 80.36 Q 101.02 80.91 102.83 81.87 Q 109.58 85.47 114.03 89.80 Q 122.90 98.44 130.03 107.74 A 0.87 0.87 0.0 0 0 131.21 107.93 Q 134.62 105.64 137.18 102.68 Q 144.31 94.42 149.50 88.26 Q 150.53 87.03 158.56 80.03 A 1.06 0.85 -85.1 0 0 158.74 79.84 L 161.39 76.39 A 1.38 1.37 -75.8 0 1 162.25 75.87 Q 172.33 74.17 179.02 76.56 Q 191.47 81.01 199.69 86.39 Q 204.33 89.43 210.29 96.97 C 213.50 101.02 214.96 104.73 217.79 109.94 Q 219.35 112.82 219.37 118.93 Q 219.39 128.87 219.37 138.81 C 219.35 143.73 215.59 150.00 212.71 154.73 Q 202.72 171.16 185.19 177.39 Q 182.59 178.31 180.51 179.42 C 175.19 182.28 169.44 182.14 161.75 182.19 C 155.52 182.23 151.11 181.81 145.58 179.66 Q 139.52 177.31 134.52 175.88 A 3.87 3.80 68.2 0 1 133.61 175.48 Q 130.23 173.44 127.52 173.29 C 124.48 173.12 122.04 174.89 119.43 175.96 C 110.57 179.63 96.74 179.71 88.39 174.07 C 83.73 170.92 79.61 168.02 73.69 171.22 A 2.45 2.37 -59.4 0 1 72.63 171.51 Z M 60.30 139.91 Q 57.80 132.04 61.09 125.41 Q 63.20 121.18 66.64 117.88 Q 68.99 115.62 72.62 115.78 C 78.70 116.65 84.52 122.86 88.08 127.60 C 94.33 135.90 102.35 144.74 111.34 151.01 C 114.74 153.38 117.05 156.57 120.60 158.79 Q 126.19 162.27 132.21 165.81 C 136.33 168.23 140.03 168.97 144.51 170.73 C 153.17 174.14 163.31 174.55 172.48 173.46 C 177.80 172.82 182.38 170.54 186.12 169.03 C 192.85 166.32 199.47 160.92 203.05 155.80 C 207.61 149.29 210.46 144.40 211.49 137.00 Q 212.86 127.06 211.49 116.99 Q 210.65 110.82 207.26 105.40 C 199.77 93.42 186.82 85.09 173.26 82.77 Q 167.42 81.78 162.82 83.46 C 159.91 84.52 156.39 88.20 154.36 89.86 A 1.25 1.25 0.0 0 0 154.42 91.84 Q 155.98 92.97 157.75 91.90 C 163.95 88.13 173.22 88.87 179.50 93.00 Q 186.95 97.90 188.61 99.66 Q 192.95 104.24 194.03 106.79 Q 195.26 109.68 198.03 119.08 A 3.69 3.63 36.4 0 1 198.19 120.08 Q 198.33 125.63 196.11 132.01 C 194.15 137.64 184.91 146.74 179.34 147.38 Q 162.30 149.35 148.36 139.33 C 143.44 135.80 138.30 131.62 134.79 126.40 C 131.86 122.04 128.21 118.90 125.72 114.65 Q 124.32 112.26 118.56 104.49 Q 110.99 94.29 101.44 89.34 Q 100.48 88.84 91.96 85.76 C 88.62 84.54 81.89 83.84 79.39 84.41 C 64.82 87.72 53.20 94.88 47.07 108.81 Q 46.18 110.83 45.91 113.49 Q 45.05 122.25 45.83 131.01 C 46.01 133.02 46.71 136.29 47.67 138.28 Q 54.74 152.95 68.64 162.36 Q 72.01 164.65 75.53 165.56 A 1.64 1.64 0.0 0 0 77.54 163.64 Q 77.53 163.60 77.14 162.96 Q 76.79 162.37 76.62 162.25 C 73.90 160.27 72.51 157.33 70.25 154.77 Q 64.10 147.80 63.45 146.31 Q 61.96 142.89 60.30 139.91 Z M 156.72 116.12 Q 158.71 115.02 160.56 114.65 A 1.99 1.99 0.0 0 0 161.44 114.25 C 165.88 110.74 173.15 110.78 178.01 112.16 A 4.00 3.94 -18.9 0 1 179.26 112.76 Q 181.62 114.45 183.62 115.34 C 186.73 116.71 187.71 118.07 189.72 120.99 C 190.75 122.49 192.23 123.68 193.93 123.85 A 1.51 1.50 6.4 0 0 195.56 122.55 C 195.94 119.63 195.04 116.80 193.36 114.11 Q 190.86 110.13 189.01 106.67 A 3.03 2.94 4.6 0 0 188.14 105.68 Q 185.73 103.98 183.42 101.13 A 6.02 5.92 -2.0 0 0 182.09 99.91 L 174.29 94.67 A 1.39 1.18 63.6 0 0 173.87 94.49 Q 167.23 93.07 159.25 93.98 C 155.01 94.47 151.38 97.82 147.50 101.15 C 143.16 104.87 140.23 109.48 135.07 116.08 Q 133.71 117.81 134.65 119.43 Q 136.60 122.81 139.57 125.21 A 2.68 2.67 46.9 0 0 142.79 125.32 L 149.43 120.65 A 0.43 0.32 8.0 0 1 149.52 120.60 Q 152.72 118.93 154.01 117.79 Q 154.49 117.36 156.72 116.12 Z M 180.00 117.29 C 178.77 114.41 173.05 114.66 170.65 115.34 Q 161.23 117.98 153.41 123.34 A 5.57 5.14 -71.3 0 1 152.51 123.83 Q 148.67 125.41 145.10 128.02 A 1.82 1.82 0.0 0 0 144.78 130.66 Q 148.97 135.68 153.80 137.64 A 3.14 3.13 33.0 0 0 157.24 136.91 C 160.63 133.38 165.44 128.27 170.47 125.41 Q 174.16 123.31 179.13 119.97 A 2.28 2.15 -28.8 0 0 180.00 117.29 Z M 70.55 124.05 Q 68.84 121.92 66.18 123.93 C 61.30 127.61 61.34 131.74 63.98 137.31 Q 67.05 143.76 67.85 144.88 Q 69.96 147.87 76.80 156.49 A 18.38 18.14 0.5 0 0 79.77 159.47 C 84.82 163.46 87.37 165.84 90.97 167.48 Q 94.80 169.24 104.92 171.64 C 109.19 172.65 116.71 170.49 120.40 169.15 C 122.09 168.54 123.44 166.90 122.09 165.25 Q 117.95 160.19 111.51 159.89 Q 105.08 159.59 101.80 159.59 Q 100.34 159.59 90.35 156.16 A 3.87 3.86 73.0 0 1 89.28 155.59 L 80.81 149.10 A 3.74 3.66 3.2 0 1 79.97 148.18 Q 77.91 145.04 74.80 140.76 Q 71.33 135.97 70.76 132.96 Q 70.59 132.10 70.64 129.43 A 2.49 2.28 -37.2 0 1 70.77 128.72 Q 71.50 126.63 70.98 124.87 A 2.38 2.28 18.6 0 0 70.55 124.05 Z M 79.84 137.88 L 79.37 139.36 A 1.36 1.36 0.0 0 0 79.50 140.46 Q 87.49 153.60 102.75 155.31 Q 103.64 155.41 104.10 155.08 A 1.00 0.97 54.3 0 0 104.31 153.68 Q 102.39 151.11 100.16 148.85 C 97.51 146.15 93.99 144.65 90.84 143.23 C 87.32 141.64 84.34 139.24 81.72 137.28 A 1.21 1.21 0.0 0 0 79.84 137.88 Z" /><path fill="#ecf7fb" d=" M 72.62 115.78 C 69.80 113.05 70.04 110.17 73.56 108.30 A 1.13 1.12 46.2 0 1 74.67 108.33 Q 83.30 113.38 88.44 118.56 Q 101.54 131.78 112.93 142.08 Q 122.33 150.58 128.91 154.61 C 138.18 160.31 149.60 165.19 160.56 164.50 Q 171.55 163.81 176.72 164.12 A 0.38 0.38 0.0 0 0 177.10 163.61 C 175.35 158.92 171.06 157.08 166.49 155.93 Q 146.02 150.79 132.33 134.42 Q 128.15 129.43 124.62 124.60 C 119.42 117.49 114.28 111.50 108.26 104.50 Q 102.97 98.33 95.71 95.36 Q 88.31 92.33 85.64 92.21 Q 69.36 91.43 59.23 104.67 C 54.82 110.42 54.86 114.58 55.39 122.35 Q 56.01 131.66 60.30 139.91 Q 61.96 142.89 63.45 146.31 Q 64.10 147.80 70.25 154.77 C 72.51 157.33 73.90 160.27 76.62 162.25 Q 76.79 162.37 77.14 162.96 Q 77.53 163.60 77.54 163.64 A 1.64 1.64 0.0 0 1 75.53 165.56 Q 72.01 164.65 68.64 162.36 Q 54.74 152.95 47.67 138.28 C 46.71 136.29 46.01 133.02 45.83 131.01 Q 45.05 122.25 45.91 113.49 Q 46.18 110.83 47.07 108.81 C 53.20 94.88 64.82 87.72 79.39 84.41 C 81.89 83.84 88.62 84.54 91.96 85.76 Q 100.48 88.84 101.44 89.34 Q 110.99 94.29 118.56 104.49 Q 124.32 112.26 125.72 114.65 C 128.21 118.90 131.86 122.04 134.79 126.40 C 138.30 131.62 143.44 135.80 148.36 139.33 Q 162.30 149.35 179.34 147.38 C 184.91 146.74 194.15 137.64 196.11 132.01 Q 198.33 125.63 198.19 120.08 A 3.69 3.63 36.4 0 0 198.03 119.08 Q 195.26 109.68 194.03 106.79 Q 192.95 104.24 188.61 99.66 Q 186.95 97.90 179.50 93.00 C 173.22 88.87 163.95 88.13 157.75 91.90 Q 155.98 92.97 154.42 91.84 A 1.25 1.25 0.0 0 1 154.36 89.86 C 156.39 88.20 159.91 84.52 162.82 83.46 Q 167.42 81.78 173.26 82.77 C 186.82 85.09 199.77 93.42 207.26 105.40 Q 210.65 110.82 211.49 116.99 Q 212.86 127.06 211.49 137.00 C 210.46 144.40 207.61 149.29 203.05 155.80 C 199.47 160.92 192.85 166.32 186.12 169.03 C 182.38 170.54 177.80 172.82 172.48 173.46 C 163.31 174.55 153.17 174.14 144.51 170.73 C 140.03 168.97 136.33 168.23 132.21 165.81 Q 126.19 162.27 120.60 158.79 C 117.05 156.57 114.74 153.38 111.34 151.01 C 102.35 144.74 94.33 135.90 88.08 127.60 C 84.52 122.86 78.70 116.65 72.62 115.78 Z" /><path fill="#d0e6f0" d=" M 72.62 115.78 Q 68.99 115.62 66.64 117.88 Q 63.20 121.18 61.09 125.41 Q 57.80 132.04 60.30 139.91 Q 56.01 131.66 55.39 122.35 C 54.86 114.58 54.82 110.42 59.23 104.67 Q 69.36 91.43 85.64 92.21 Q 88.31 92.33 95.71 95.36 Q 102.97 98.33 108.26 104.50 C 114.28 111.50 119.42 117.49 124.62 124.60 Q 128.15 129.43 132.33 134.42 Q 146.02 150.79 166.49 155.93 C 171.06 157.08 175.35 158.92 177.10 163.61 A 0.38 0.38 0.0 0 1 176.72 164.12 Q 171.55 163.81 160.56 164.50 C 149.60 165.19 138.18 160.31 128.91 154.61 Q 122.33 150.58 112.93 142.08 Q 101.54 131.78 88.44 118.56 Q 83.30 113.38 74.67 108.33 A 1.13 1.12 46.2 0 0 73.56 108.30 C 70.04 110.17 69.80 113.05 72.62 115.78 Z" /><path fill="#a6d7e8" d=" M 156.72 116.12 Q 154.49 117.36 154.01 117.79 Q 152.72 118.93 149.52 120.60 A 0.43 0.32 8.0 0 0 149.43 120.65 L 142.79 125.32 A 2.68 2.67 46.9 0 1 139.57 125.21 Q 136.60 122.81 134.65 119.43 Q 133.71 117.81 135.07 116.08 C 140.23 109.48 143.16 104.87 147.50 101.15 C 151.38 97.82 155.01 94.47 159.25 93.98 Q 167.23 93.07 173.87 94.49 A 1.39 1.18 63.6 0 1 174.29 94.67 L 182.09 99.91 A 6.02 5.92 -2.0 0 1 183.42 101.13 Q 185.73 103.98 188.14 105.68 A 3.03 2.94 4.6 0 1 189.01 106.67 Q 190.86 110.13 193.36 114.11 C 195.04 116.80 195.94 119.63 195.56 122.55 A 1.51 1.50 6.4 0 1 193.93 123.85 C 192.23 123.68 190.75 122.49 189.72 120.99 C 187.71 118.07 186.73 116.71 183.62 115.34 Q 181.62 114.45 179.26 112.76 A 4.00 3.94 -18.9 0 0 178.01 112.16 C 173.15 110.78 165.88 110.74 161.44 114.25 A 1.99 1.99 0.0 0 1 160.56 114.65 Q 158.71 115.02 156.72 116.12 Z" /><path fill="#fee674" d=" M 180.00 117.29 A 2.28 2.15 -28.8 0 1 179.13 119.97 Q 174.16 123.31 170.47 125.41 C 165.44 128.27 160.63 133.38 157.24 136.91 A 3.14 3.13 33.0 0 1 153.80 137.64 Q 148.97 135.68 144.78 130.66 A 1.82 1.82 0.0 0 1 145.10 128.02 Q 148.67 125.41 152.51 123.83 A 5.57 5.14 -71.3 0 0 153.41 123.34 Q 161.23 117.98 170.65 115.34 C 173.05 114.66 178.77 114.41 180.00 117.29 Z" /><path fill="#a6d7e8" d=" M 70.98 124.87 Q 71.50 126.63 70.77 128.72 A 2.49 2.28 -37.2 0 0 70.64 129.43 Q 70.59 132.10 70.76 132.96 Q 71.33 135.97 74.80 140.76 Q 77.91 145.04 79.97 148.18 A 3.74 3.66 3.2 0 0 80.81 149.10 L 89.28 155.59 A 3.87 3.86 73.0 0 0 90.35 156.16 Q 100.34 159.59 101.80 159.59 Q 105.08 159.59 111.51 159.89 Q 117.95 160.19 122.09 165.25 C 123.44 166.90 122.09 168.54 120.40 169.15 C 116.71 170.49 109.19 172.65 104.92 171.64 Q 94.80 169.24 90.97 167.48 C 87.37 165.84 84.82 163.46 79.77 159.47 A 18.38 18.14 0.5 0 1 76.80 156.49 Q 69.96 147.87 67.85 144.88 Q 67.05 143.76 63.98 137.31 C 61.34 131.74 61.30 127.61 66.18 123.93 Q 68.84 121.92 70.55 124.05 A 2.38 2.28 18.6 0 1 70.98 124.87 Z" /><path fill="#f5c256" d=" M 79.84 137.88 A 1.21 1.21 0.0 0 1 81.72 137.28 C 84.34 139.24 87.32 141.64 90.84 143.23 C 93.99 144.65 97.51 146.15 100.16 148.85 Q 102.39 151.11 104.31 153.68 A 1.00 0.97 54.3 0 1 104.10 155.08 Q 103.64 155.41 102.75 155.31 Q 87.49 153.60 79.50 140.46 A 1.36 1.36 0.0 0 1 79.37 139.36 L 79.84 137.88 Z" /></svg>';

const KLAVIYO_TOOLSETS = [
  'accounts:read',
  'campaigns:read', 'campaigns:write',
  'catalogs:read', 'catalogs:write',
  'coupons:read', 'coupons:write',
  'events:read', 'events:write',
  'flows:read', 'flows:write',
  'forms:read', 'forms:write',
  'images:read', 'images:write',
  'lists:read', 'lists:write',
  'metrics:read',
  'profiles:read', 'profiles:write',
  'segments:read', 'segments:write',
  'subscriptions:read', 'subscriptions:write',
  'tags:read', 'tags:write',
  'templates:read', 'templates:write',
];

const KLAVIYO_MCP_URL = `https://mcp.klaviyo.com/mcp?${new URLSearchParams({
  'read-only': 'false',
  'disable-tools-with-user-generated-content': 'false',
  'core-tools-only': 'false',
  'include-output-schemas': 'true',
  beta: 'false',
  toolsets: KLAVIYO_TOOLSETS.join(','),
}).toString()}`;

// Stable, remote-capable actions documented by Klaviyo on 2026-09-03. Webhook deletion,
// review mutation, profile-deletion requests, and beta account/security tools are deliberately
// absent. User-generated profile/event reads remain because they are essential commerce data;
// callers must continue treating their content as untrusted input.
const KLAVIYO_ALLOWED_TOOLS = [
  'get_account_details',
  'get_campaigns', 'get_campaign', 'create_campaign', 'assign_template_to_campaign_message',
  'get_campaign_send_job', 'get_campaign_recipient_estimation_job',
  'get_campaign_recipient_estimation', 'get_campaign_message',
  'refresh_campaign_recipient_estimation', 'create_campaign_clone', 'update_campaign',
  'delete_campaign', 'update_campaign_message', 'update_image_for_campaign_message',
  'send_campaign', 'cancel_campaign_send',
  'get_catalog_items', 'get_catalog_item', 'get_catalog_variant', 'get_catalog_category',
  'get_bulk_create_catalog_items_job', 'get_bulk_update_catalog_items_job',
  'get_bulk_delete_catalog_items_job', 'get_bulk_create_variants_job',
  'get_bulk_update_variants_job', 'get_bulk_delete_variants_job', 'get_catalog_variants',
  'get_catalog_categories', 'get_bulk_create_catalog_items_jobs',
  'get_bulk_update_catalog_items_jobs', 'get_bulk_delete_catalog_items_jobs',
  'get_bulk_create_variants_jobs', 'get_bulk_update_variants_jobs',
  'get_bulk_delete_variants_jobs', 'create_catalog_item', 'update_catalog_item',
  'delete_catalog_item', 'add_categories_to_catalog_item', 'remove_categories_from_catalog_item',
  'update_categories_for_catalog_item', 'create_back_in_stock_subscription',
  'create_catalog_variant', 'update_catalog_variant', 'delete_catalog_variant',
  'create_catalog_category', 'update_catalog_category', 'delete_catalog_category',
  'add_items_to_catalog_category', 'remove_items_from_catalog_category',
  'update_items_for_catalog_category', 'bulk_create_catalog_items', 'bulk_update_catalog_items',
  'bulk_delete_catalog_items', 'bulk_create_catalog_variants', 'bulk_update_catalog_variants',
  'bulk_delete_catalog_variants',
  'get_events', 'get_metrics', 'get_metric', 'query_metric_aggregates', 'get_event',
  'get_custom_metric', 'get_mapped_metric', 'get_metric_property', 'get_custom_metrics',
  'get_mapped_metrics', 'get_flows_triggered_by_metric', 'create_custom_metric',
  'update_custom_metric', 'delete_custom_metric', 'update_mapped_metric', 'bulk_create_events',
  'get_event_bulk_export_job',
  'get_flows', 'get_flow', 'get_flow_message', 'get_flow_action', 'create_flow', 'update_flow',
  'delete_flow', 'update_flow_action',
  'get_lists', 'get_list', 'get_segments', 'get_segment', 'get_flows_triggered_by_list',
  'get_flows_triggered_by_segment', 'create_list', 'update_list', 'delete_list',
  'add_profiles_to_list', 'remove_profiles_from_list', 'create_segment', 'update_segment',
  'delete_segment',
  'upload_image_from_url', 'get_image', 'get_images', 'update_image',
  'get_profiles', 'get_profile', 'create_profile', 'update_profile',
  'subscribe_profile_to_marketing', 'unsubscribe_profile_from_marketing',
  'get_bulk_import_profiles_job', 'get_bulk_suppress_profiles_job',
  'get_bulk_unsuppress_profiles_job', 'get_push_token', 'get_bulk_import_profiles_jobs',
  'get_bulk_suppress_profiles_jobs', 'get_bulk_unsuppress_profiles_jobs', 'get_push_tokens',
  'create_or_update_profile', 'create_push_token', 'delete_push_token', 'bulk_import_profiles',
  'bulk_suppress_profiles', 'bulk_unsuppress_profiles', 'merge_profiles',
  'get_profile_bulk_export_job',
  'get_campaign_report', 'get_flow_report', 'query_form_values', 'query_form_series',
  'query_segment_values', 'query_segment_series',
  'create_email_template', 'get_email_template', 'create_dnd_email_template',
  'update_dnd_email_template', 'list_email_templates', 'update_email_template',
  'clone_email_template', 'delete_email_template', 'render_email_template',
  'get_universal_content', 'get_all_universal_content', 'create_universal_content',
  'update_universal_content', 'delete_universal_content',
  'get_coupon', 'get_bulk_create_coupon_codes_job', 'get_coupons', 'get_coupon_codes',
  'get_coupon_code', 'get_bulk_create_coupon_code_jobs', 'create_coupon', 'update_coupon',
  'create_coupon_code', 'update_coupon_code', 'delete_coupon_code', 'delete_coupon',
  'bulk_create_coupon_codes',
  'get_tag_group', 'get_tags', 'get_tag', 'get_tag_groups', 'create_tag', 'update_tag',
  'delete_tag', 'create_tag_group', 'update_tag_group', 'delete_tag_group', 'tag_campaigns',
  'tag_flows', 'tag_lists', 'tag_segments', 'remove_tag_from_campaigns',
  'remove_tag_from_flows', 'remove_tag_from_lists', 'remove_tag_from_segments',
  'get_form', 'get_forms', 'get_form_version', 'create_form', 'delete_form',
];

// Exact action set in PayPal's official MCP tool reference on 2026-09-03. It includes the
// complete merchant transaction loop; arbitrary API execution and any future upstream action are
// denied by the shared catalog policy until separately reviewed.
const PAYPAL_ALLOWED_TOOLS = [
  'create_invoice', 'list_invoices', 'get_invoice', 'send_invoice', 'send_invoice_reminder',
  'cancel_sent_invoice', 'generate_invoice_qr_code',
  'create_order', 'get_order', 'pay_order', 'create_refund', 'get_refund',
  'list_disputes', 'get_dispute', 'accept_dispute_claim',
  'create_shipment_tracking', 'get_shipment_tracking',
  'create_product', 'list_products', 'show_product_details', 'update_product',
  'create_subscription_plan', 'update_plan', 'list_subscription_plans',
  'show_subscription_plan_details', 'create_subscription', 'show_subscription_details',
  'update_subscription', 'cancel_subscription',
  'list_transactions',
];

type SensitiveOperation = 'money' | 'external_communication' | 'fulfillment'
  | 'consent' | 'bulk_or_automation' | 'business_record';

const KLAVIYO_HIGH_IMPACT = new Map<string, SensitiveOperation>([
  ['send_campaign', 'external_communication'],
  ['create_back_in_stock_subscription', 'consent'],
  ['subscribe_profile_to_marketing', 'consent'],
  ['unsubscribe_profile_from_marketing', 'consent'],
  ['bulk_suppress_profiles', 'consent'],
  ['bulk_unsuppress_profiles', 'consent'],
  ['add_profiles_to_list', 'bulk_or_automation'],
  ['remove_profiles_from_list', 'bulk_or_automation'],
  ['bulk_import_profiles', 'bulk_or_automation'],
  ['bulk_create_catalog_items', 'bulk_or_automation'],
  ['bulk_update_catalog_items', 'bulk_or_automation'],
  ['bulk_create_catalog_variants', 'bulk_or_automation'],
  ['bulk_update_catalog_variants', 'bulk_or_automation'],
  ['bulk_create_events', 'bulk_or_automation'],
  ['bulk_create_coupon_codes', 'bulk_or_automation'],
]);

const KLAVIYO_DESTRUCTIVE = new Set([
  'cancel_campaign_send',
  'merge_profiles',
]);

const PAYPAL_HIGH_IMPACT = new Map<string, SensitiveOperation>([
  ['send_invoice', 'external_communication'],
  ['send_invoice_reminder', 'external_communication'],
  ['pay_order', 'money'],
  ['create_refund', 'money'],
  ['accept_dispute_claim', 'money'],
  ['create_subscription_plan', 'money'],
  ['update_plan', 'money'],
  ['create_subscription', 'money'],
  ['update_subscription', 'money'],
  ['create_shipment_tracking', 'fulfillment'],
]);

const PAYPAL_DESTRUCTIVE = new Set([
  'cancel_sent_invoice',
  'cancel_subscription',
]);

// Oracle's standard SuiteApp intentionally exposes this 14-tool role-bounded surface. We pin the
// SuiteApp namespace instead of `/all`, which would silently add tenant custom tools. Record
// create/update calls are legitimate ERP operations but can affect downstream accounting and
// fulfillment, so they are sensitive actions under operation permissions.
const NETSUITE_ALLOWED_TOOLS = [
  'ns_createRecord', 'ns_getRecord', 'ns_getRecordTypeMetadata', 'ns_updateRecord',
  'ns_getAccountingBooks', 'ns_getAccountingContexts', 'ns_getNexusIds',
  'ns_getSubsidiaries', 'ns_listAllReports', 'ns_runReport',
  'ns_listSavedSearches', 'ns_runSavedSearch',
  'ns_runCustomSuiteQL', 'ns_getSuiteQLMetadata',
];

const NETSUITE_TOOL_POLICIES: Record<string, ConnectorActionPolicy> = Object.fromEntries(
  NETSUITE_ALLOWED_TOOLS.map((name) => [
    name,
    name === 'ns_createRecord' || name === 'ns_updateRecord'
      ? {
          risk: 'H' as const,
          confirmation: 'fresh' as const,
          sensitive_operation: 'business_record',
          max_batch_size: 1,
        }
      : { risk: 'R' as const, confirmation: 'none' as const, max_batch_size: 25 },
  ]),
);

const READ_ACTION_RE = /^(?:get|list|query|show|render)_/;

function actionPolicy(
  name: string,
  highImpact: ReadonlyMap<string, SensitiveOperation>,
  destructive: ReadonlySet<string>,
): ConnectorActionPolicy {
  if (name.startsWith('delete_') || name.startsWith('bulk_delete_') || destructive.has(name)) {
    return {
      risk: 'D', confirmation: 'destructive', sensitive_operation: 'delete', max_batch_size: 25,
    };
  }
  const sensitiveOperation = highImpact.get(name);
  if (sensitiveOperation) {
    return {
      risk: 'H', confirmation: 'fresh', sensitive_operation: sensitiveOperation, max_batch_size: 25,
    };
  }
  if (READ_ACTION_RE.test(name) || name === 'generate_invoice_qr_code') {
    return { risk: 'R', confirmation: 'none', max_batch_size: 25 };
  }
  return { risk: 'W', confirmation: 'preview', max_batch_size: 25 };
}

function toolPolicies(
  tools: string[],
  highImpact: ReadonlyMap<string, SensitiveOperation>,
  destructive: ReadonlySet<string>,
): Record<string, ConnectorActionPolicy> {
  return Object.fromEntries(tools.map((name) => [name, actionPolicy(name, highImpact, destructive)]));
}

const KLAVIYO_TOOL_POLICIES = toolPolicies(
  KLAVIYO_ALLOWED_TOOLS,
  KLAVIYO_HIGH_IMPACT,
  KLAVIYO_DESTRUCTIVE,
);
const PAYPAL_TOOL_POLICIES = toolPolicies(
  PAYPAL_ALLOWED_TOOLS,
  PAYPAL_HIGH_IMPACT,
  PAYPAL_DESTRUCTIVE,
);

export const REMOTE_COMMERCE_ENTRIES: CatalogEntry[] = [
  {
    id: 'klaviyo',
    display_name: 'Klaviyo',
    icon_svg: KLAVIYO_ICON_SVG,
    icon_source_url: 'https://logos.composio.dev/api/klaviyo',
    icon_source_sha256: '655fc42ba08b624ac572e7abde18bb655c0485b64d675a2c68cf799f48f06ff1',
    category: 'commerce',
    description_zh: '管理营销活动、客户、商品目录、自动化流程、订阅与效果数据。',
    description_en: 'Manage campaigns, profiles, catalogs, flows, subscriptions, and performance data.',
    description_ja: "キャンペーン、プロフィール、カタログ、フロー、購読、パフォーマンス情報を管理します。",
    description_pt: "Gerencie campanhas, perfis, catálogos, fluxos, assinaturas e dados de desempenho.",
    auth_mode: 'mcp_dcr',
    allowed_tools: KLAVIYO_ALLOWED_TOOLS,
    tool_policies: KLAVIYO_TOOL_POLICIES,
    transport_template: {
      kind: 'streamable-http',
      url: KLAVIYO_MCP_URL,
      oauth_header_key: 'Authorization',
    },
  },
  {
    id: 'paypal',
    display_name: 'PayPal',
    icon_svg: PAYPAL_ICON_SVG,
    icon_source_url: 'https://logos.composio.dev/api/paypal',
    icon_source_sha256: '50e3507dd5a6f972890113084eea453a7b0e7d02c720dc92970e8fb5ac7016c2',
    category: 'commerce',
    description_zh: '管理 PayPal 正式环境的订单、付款、退款、发票、争议、物流与订阅。',
    description_en: 'Manage production PayPal orders, payments, refunds, invoices, disputes, tracking, and subscriptions.',
    description_ja: "PayPal 本番環境の注文、支払、返金、請求書、異議申し立て、追跡、サブスクリプションを管理します。",
    description_pt: "Gerencie pedidos, pagamentos, reembolsos, faturas, disputas, rastreamento e assinaturas PayPal em produção.",
    auth_mode: 'mcp_dcr',
    allowed_tools: PAYPAL_ALLOWED_TOOLS,
    tool_policies: PAYPAL_TOOL_POLICIES,
    transport_template: {
      kind: 'streamable-http',
      url: 'https://mcp.paypal.com/http',
      oauth_header_key: 'Authorization',
    },
  },
  {
    // Compatibility-only identity: retain the endpoint for existing sandbox grants.
    id: 'paypal-sandbox',
    display_name: 'PayPal Sandbox',
    icon_svg: PAYPAL_ICON_SVG,
    icon_source_url: 'https://logos.composio.dev/api/paypal',
    icon_source_sha256: '50e3507dd5a6f972890113084eea453a7b0e7d02c720dc92970e8fb5ac7016c2',
    category: 'commerce',
    description_zh: '管理 PayPal Sandbox 测试环境的订单、付款、退款、发票、争议、物流与订阅。',
    description_en: 'Manage PayPal Sandbox test orders, payments, refunds, invoices, disputes, tracking, and subscriptions.',
    description_ja: "PayPal Sandbox のテスト注文、支払、返金、請求書、異議申し立て、追跡、サブスクリプションを管理します。",
    description_pt: "Gerencie pedidos de teste, pagamentos, reembolsos, faturas, disputas, rastreamento e assinaturas no PayPal Sandbox.",
    auth_mode: 'mcp_dcr',
    catalog_parent_id: 'paypal',
    allowed_tools: PAYPAL_ALLOWED_TOOLS,
    tool_policies: PAYPAL_TOOL_POLICIES,
    transport_template: {
      kind: 'streamable-http',
      url: 'https://mcp.sandbox.paypal.com/http',
      oauth_header_key: 'Authorization',
    },
  },
  {
    id: 'netsuite', setup_guide_id: 'netsuite',
    display_name: 'Oracle NetSuite',
    icon_svg: NETSUITE_ICON_SVG,
    icon_source_url: 'https://logos.composio.dev/api/netsuite',
    icon_source_sha256: '7eba8c219e9eca1f62a6f3e6309041630a2dba869d07491c3d83e27f18d1efb5',
    category: 'commerce',
    description_zh: '读取 ERP 记录、报表、Saved Search 与 SuiteQL，并在确认后创建或更新业务记录。',
    description_en: 'Read ERP records, reports, saved searches, and SuiteQL; create or update records after confirmation.',
    description_ja: "ERP レコード、レポート、保存済み検索、SuiteQL を読み取り、確認後にレコードを作成・更新します。",
    description_pt: "Leia registros ERP, relatórios, pesquisas salvas e SuiteQL; crie ou atualize registros após confirmação.",
    auth_mode: 'mcp_dcr',
    connection_setup: {
      guide_url: 'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1498754928.html',
      instructions_zh: '管理员需启用 Server SuiteScript、OAuth 2.0 和 REST Web Services。授权时使用非 Administrator、非全权限角色，授予 MCP Server Connection、Log in using OAuth 2.0 Access Tokens；读取记录还需 REST Web Services 及对应记录权限。',
      instructions_en: 'An administrator must enable Server SuiteScript, OAuth 2.0 and REST Web Services. Authorize a non-Administrator, non-full-permission role with MCP Server Connection and Log in using OAuth 2.0 Access Tokens; record reads also need REST Web Services and relevant record permissions.',
      instructions_ja: '管理者が Server SuiteScript、OAuth 2.0、REST Web Services を有効にします。Administrator や全権限ロールではなく、MCP Server Connection と Log in using OAuth 2.0 Access Tokens を持つロールで認可します。レコード参照には REST Web Services と対象レコードの権限も必要です。',
      instructions_pt: 'Um administrador deve habilitar Server SuiteScript, OAuth 2.0 e REST Web Services. Autorize uma função sem Administrator nem acesso total, com MCP Server Connection e Log in using OAuth 2.0 Access Tokens; leituras de registros também exigem REST Web Services e permissões dos registros.',
      guide_label_zh: '查看 NetSuite 官方 Account ID 指南',
      guide_label_en: 'Open the official NetSuite Account ID guide',
      guide_label_ja: "NetSuite 公式 Account ID ガイドを開く",
      guide_label_pt: "Abrir guia oficial do Account ID NetSuite",
      fields: [{
        key: 'account_id',
        input: 'text',
        label_zh: 'NetSuite Account ID',
        label_en: 'NetSuite Account ID',
        label_ja: "NetSuite アカウント ID",
        label_pt: "ID da conta NetSuite",
        help_zh: '在 Setup > Company > Company Information 查看；Sandbox 例如 123456_SB1。管理员需安装 MCP Standard Tools SuiteApp，并为 Orkas 配置启用 DCR 的 Public Client 集成记录（Client Name: Orkas）。',
        help_en: 'Find it under Setup > Company > Company Information. For Sandbox, for example 123456_SB1. An admin must install the MCP Standard Tools SuiteApp and enable a DCR Public Client integration record with Client Name: Orkas.',
        help_ja: "Setup > Company > Company Information で確認できます。Sandbox の例：123456_SB1。管理者が MCP Standard Tools SuiteApp を導入し、Client Name が Orkas の DCR Public Client 連携レコードを有効にする必要があります。",
        help_pt: "Encontre em Setup > Company > Company Information. Para Sandbox, por exemplo 123456_SB1. Um administrador deve instalar o MCP Standard Tools SuiteApp e habilitar um registro de integração DCR Public Client com Client Name: Orkas.",
        required: true,
        format: 'netsuite_account_id',
      }],
    },
    allowed_tools: NETSUITE_ALLOWED_TOOLS,
    tool_policies: NETSUITE_TOOL_POLICIES,
    transport_template: {
      kind: 'streamable-http',
      url: 'https://{{account_id}}.suitetalk.api.netsuite.com/services/mcp/v1/suiteapp/com.netsuite.mcpstandardtools',
      oauth_header_key: 'Authorization',
    },
  },
];
