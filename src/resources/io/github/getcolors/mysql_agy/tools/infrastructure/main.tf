terraform {
  required_version = ">= 1.8.0"
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "2.51.0"
    }
  }
}

provider "digitalocean" {}

locals {
  name           = "<{ digitalocean-name }>"
  ssh_sources    = <{ digitalocean-ssh-sources-json|safe }>
  client_sources = <{ digitalocean-client-sources-json|safe }>
}

data "digitalocean_vpc" "cluster" {
  region = "<{ digitalocean-region }>"
}

resource "digitalocean_droplet" "node" {
  count    = <{ node-count }>
  name     = "${local.name}-node-${count.index + 1}"
  region   = "<{ digitalocean-region }>"
  size     = "<{ digitalocean-size }>"
  image    = "<{ digitalocean-image }>"
  vpc_uuid = data.digitalocean_vpc.cluster.id
  ssh_keys = ["<{ digitalocean-ssh-keys }>"]
  tags     = ["colors-mysql-agy", local.name]

  lifecycle {
    prevent_destroy = <{ compute-prevent-destroy }>
  }
}

resource "digitalocean_reserved_ip" "endpoint" {
  region = "<{ digitalocean-region }>"

  lifecycle {
    prevent_destroy = <{ compute-prevent-destroy }>
    ignore_changes  = [droplet_id]
  }
}

resource "digitalocean_firewall" "cluster" {
  name        = "${local.name}-cluster"
  droplet_ids = digitalocean_droplet.node[*].id

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = local.ssh_sources
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "<{ mysql-port }>"
    source_addresses = local.client_sources
  }
  inbound_rule {
    protocol         = "icmp"
    source_addresses = concat(local.ssh_sources, [data.digitalocean_vpc.cluster.ip_range])
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "1-65535"
    source_addresses = [data.digitalocean_vpc.cluster.ip_range]
  }
  inbound_rule {
    protocol         = "udp"
    port_range       = "1-65535"
    source_addresses = [data.digitalocean_vpc.cluster.ip_range]
  }

  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  lifecycle {
    prevent_destroy = <{ compute-prevent-destroy }>
  }
}

output "node_public_ips" {
  value = digitalocean_droplet.node[*].ipv4_address
}
output "node_private_ips" {
  value = digitalocean_droplet.node[*].ipv4_address_private
}
output "node_droplet_ids" {
  value = digitalocean_droplet.node[*].id
}
output "reserved_ip" {
  value = digitalocean_reserved_ip.endpoint.ip_address
}
output "vpc_id" {
  value = data.digitalocean_vpc.cluster.id
}
output "vpc_ip_range" {
  value = data.digitalocean_vpc.cluster.ip_range
}
